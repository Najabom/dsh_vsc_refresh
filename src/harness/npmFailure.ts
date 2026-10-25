/**
 * npm failure classification — pure string logic, kept out of updater.ts so it
 * can be unit-tested without the `vscode` module. npm failures are the place
 * users see the raw resolver walls; every branch here is meant to turn one
 * into a single actionable sentence.
 */

export function classifyNpmFailure(output: string): string | undefined {
  const missing = /No matching version found for (\S+)/.exec(output);
  if (missing) {
    const target = missing[1].replace(/[.,;]+$/, "");
    return `上游缺少依赖 ${target}（该版本发布不完整，或镜像未同步；已尝试官方源）`;
  }
  if (/ERESOLVE/.test(output)) return "npm 依赖冲突（ERESOLVE，已尝试 --force）";
  if (/EBUSY/.test(output)) return "更新文件被占用（EBUSY）：可能有 dsh 进程仍在运行，请先停止它再重试";
  if (/EACCES|EPERM/.test(output)) return "npm 权限不足（EACCES/EPERM），请检查全局目录权限";
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET/.test(output)) return "npm 网络不可达或超时，请检查网络后重试";
  if (/EINTEGRITY/.test(output)) return "npm 包完整性校验失败（EINTEGRITY），可清缓存后重试";
  return undefined;
}
