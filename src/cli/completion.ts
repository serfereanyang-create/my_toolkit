export type CompletionShell = 'bash' | 'zsh' | 'fish' | 'powershell';

const options = ['--help', '--version', '--provider', '--model', '--base-url', '--approval', '--workspace', '--session-dir', '--config', '--profile', '--resume', '--prompt', '--max-steps', '--no-banner', '--json', '--no-color', '--quiet', '--debug', '--ci', '--no-input', '--doctor'];
const commands = ['completion'];
const shells: CompletionShell[] = ['bash', 'zsh', 'fish', 'powershell'];

export function completionScript(shell: CompletionShell) {
  if (shell === 'bash') return bashCompletion();
  if (shell === 'zsh') return zshCompletion();
  if (shell === 'fish') return fishCompletion();
  return powershellCompletion();
}

function bashCompletion() {
  return `# bash completion for aicode
_aicode_completion() {
  local cur="${'${COMP_WORDS[COMP_CWORD]}'}"
  local prev="${'${COMP_WORDS[COMP_CWORD-1]}'}"
  if [[ "$prev" == "completion" ]]; then
    COMPREPLY=( $(compgen -W "${shells.join(' ')}" -- "$cur") )
    return 0
  fi
  COMPREPLY=( $(compgen -W "${[...commands, ...options].join(' ')}" -- "$cur") )
}
complete -F _aicode_completion aicode
`;
}

function zshCompletion() {
  return `#compdef aicode
_arguments \\
  '1:command:(${commands.join(' ')})' \\
  '*::arg:->args'
case $words[2] in
  completion)
    _values 'shell' ${shells.join(' ')}
    ;;
  *)
    _values 'option' ${options.join(' ')}
    ;;
esac
`;
}

function fishCompletion() {
  return [...commands.map((command) => `complete -c aicode -f -a ${command}`), ...options.map((option) => `complete -c aicode -f -l ${option.replace(/^--/, '')}`), `complete -c aicode -n '__fish_seen_subcommand_from completion' -f -a '${shells.join(' ')}'`].join('\n') + '\n';
}

function powershellCompletion() {
  const words = [...commands, ...options, ...shells].map((word) => `'${word.replace(/'/g, "''")}'`).join(', ');
  return `Register-ArgumentCompleter -Native -CommandName aicode -ScriptBlock {
  param($wordToComplete)
  @(${words}) | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}
`;
}
