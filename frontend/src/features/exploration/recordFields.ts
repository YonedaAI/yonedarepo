/** The text entries of a recorded list field; undefined when the field is not a list. */
export function textList(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined;
}
