/** Account rules shared by the server's Better Auth settings and the forms that create accounts. */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/** New accounts sign up with a Gmail address, which keeps throwaway sign-ups down. The demo's visitors are created without signing up. */
export const SIGN_UP_EMAIL_DOMAINS: readonly string[] = ["gmail.com", "googlemail.com"];
export const SIGN_UP_EMAIL_RULE = "Sign up with a Gmail address.";

export function emailInDomains(email: string, domains: readonly string[] = SIGN_UP_EMAIL_DOMAINS): boolean {
  const address = email.trim().toLowerCase(), at = address.lastIndexOf("@");
  return at > 0 && domains.includes(address.slice(at + 1));
}
