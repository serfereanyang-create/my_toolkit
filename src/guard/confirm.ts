export type GuardConfirmationOption = { label: string; description: string };
export type GuardConfirmationRequest = { title: string; question: string; options: GuardConfirmationOption[] };
export type GuardConfirmationResult = { selectedLabel: string; source: 'popup' | 'terminal' };

export function formatTerminalOptions(request: GuardConfirmationRequest) {
  return [
    request.title,
    request.question,
    ...request.options.map((option, index) => `${index + 1}. ${option.label}：${option.description}`),
  ].join('\n');
}
