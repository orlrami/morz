/** w12/voice-input: global key handlers must not consume text-control input. */
export function isEditableTarget(event: Pick<Event, 'target'>): boolean {
  const target = event.target
  if (!(target instanceof HTMLElement)) return false
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable ||
    target.closest('[contenteditable]') !== null
  )
}
