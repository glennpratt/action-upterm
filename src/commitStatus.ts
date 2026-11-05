import * as core from '@actions/core';
import * as github from '@actions/github';

/**
 * The ssh-command-status opt-in: the session's ssh command, published as a
 * commit status, so that a program can find it while the job is still running.
 * GitHub serves a job's log and step outputs only once the job has finished,
 * and artifacts uploaded mid-job aren't listed on GHES until the run has; a
 * commit status is live on both.
 *
 * The first status, posted before the launch, doubles as the permission check:
 * whoever opted in is relying on the status, so a token that can't write one
 * fails the step before there is a session nobody can find. After that,
 * failures only warn: a session someone may be using is not to be ended over
 * a status update.
 */

// GitHub refuses a longer status description.
const MAX_DESCRIPTION = 140;

/** Where the status goes, saved for the post step, which posts the last one. */
export interface StatusTarget {
  owner: string;
  repo: string;
  sha: string;
  context: string;
  targetUrl: string;
}

const STATE_KEY = 'sshCommandStatus';

type State = 'pending' | 'success' | 'error';

type Octokit = ReturnType<typeof github.getOctokit>;

/**
 * The commit the status goes on: for a pull request, its head, which is what
 * the pull request shows statuses for. GITHUB_SHA there is the merge commit.
 */
function statusSha(): string {
  const head = github.context.payload?.pull_request?.head?.sha;
  return head || github.context.sha || process.env.GITHUB_SHA || '';
}

function statusTarget(): StatusTarget {
  const {owner, repo} = github.context.repo;
  const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const runUrl = `${server}/${owner}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT || '1'}`;
  return {
    owner,
    repo,
    sha: statusSha(),
    context: core.getInput('ssh-command-status-context').trim() || `upterm / ${process.env.GITHUB_JOB || 'job'}`,
    targetUrl: runUrl
  };
}

function token(): string {
  return core.getInput('github-token') || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
}

export class SshCommandStatus {
  private constructor(
    private readonly octokit: Octokit,
    private readonly target: StatusTarget
  ) {}

  /**
   * The opt-in's reporter for the main step, or null when ssh-command-status
   * is off. Built before the launch: the token's input is taken out of the
   * environment then, so that the session's guests can't read it.
   */
  static forMain(): SshCommandStatus | null {
    if (core.getInput('ssh-command-status') !== 'true') return null;
    const t = token();
    if (!t) throw new Error('ssh-command-status needs a token: set github-token, or leave it at its default of github.token.');
    return new SshCommandStatus(github.getOctokit(t), statusTarget());
  }

  /** The post step's reporter, or null when main posted no status. */
  static forPost(): SshCommandStatus | null {
    const saved = core.getState(STATE_KEY);
    const t = token();
    if (!saved || !t) return null;
    try {
      return new SshCommandStatus(github.getOctokit(t), JSON.parse(saved) as StatusTarget);
    } catch (error) {
      core.debug(`Could not read the saved ssh-command-status target: ${error}`);
      return null;
    }
  }

  private async post(state: State, description: string): Promise<void> {
    await this.octokit.rest.repos.createCommitStatus({
      owner: this.target.owner,
      repo: this.target.repo,
      sha: this.target.sha,
      state,
      context: this.target.context,
      description: description.slice(0, MAX_DESCRIPTION),
      target_url: this.target.targetUrl
    });
  }

  /** Before the launch: posts `pending`, failing the step if it can't. */
  async starting(): Promise<void> {
    try {
      await this.post('pending', 'Starting an upterm session');
    } catch (error) {
      const status = (error as {status?: number})?.status;
      const hint = status === 403 || status === 404 ? ' Grant it with `permissions: statuses: write` on the job.' : '';
      throw new Error(`ssh-command-status could not post a commit status on ${this.target.sha}: ${error}.${hint}`);
    }
    core.info(`Publishing the ssh command as commit status "${this.target.context}" on ${this.target.sha}`);
  }

  /**
   * The session is up: the ssh command, as the status's description. Only
   * now is the target saved for the post step, so that a launch that failed
   * keeps its error rather than being marked ended.
   */
  async ready(sshCommand: string): Promise<void> {
    core.saveState(STATE_KEY, JSON.stringify(this.target));
    if (sshCommand.length > MAX_DESCRIPTION) {
      core.warning(`The ssh command is longer than a commit status holds (${MAX_DESCRIPTION} characters); the status has it cut short.`);
    }
    await this.warnOnFailure('pending', sshCommand);
  }

  /** The launch failed. */
  async failed(): Promise<void> {
    await this.warnOnFailure('error', 'The upterm session could not start');
  }

  /** The post step ended the session. */
  async ended(): Promise<void> {
    await this.warnOnFailure('success', 'The upterm session has ended');
  }

  private async warnOnFailure(state: State, description: string): Promise<void> {
    try {
      await this.post(state, description);
    } catch (error) {
      core.warning(`Could not update commit status "${this.target.context}": ${error}`);
    }
  }
}
