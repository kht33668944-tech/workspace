export function getByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes += code > 127 ? 2 : 1;
  }
  return bytes;
}

export function getMessageType(text: string): "SMS" | "LMS" {
  return getByteLength(text) > 90 ? "LMS" : "SMS";
}

export function substituteTemplate(
  template: string,
  variables: Record<string, string>
): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    return variables[key] ?? match;
  });
}
