const invocation = /^\s*@(?:ai|change[\s-]?agent)(?=$|[\s,，:：.。!！?？])/iu;

export function isAiInvocation(text: string): boolean {
  return invocation.test(text);
}

export function aiTask(text: string): string {
  return text.replace(invocation, "").replace(/^[\s,，:：]+/u, "").trim();
}
