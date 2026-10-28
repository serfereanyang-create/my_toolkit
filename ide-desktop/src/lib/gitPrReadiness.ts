export function canCreatePullRequest(remotes: string[] | undefined): boolean {
  return (remotes ?? []).some((remote) => remote !== '.');
}
