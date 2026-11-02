import Image from "next/image";
import { avatarFor, monogramFor } from "../avatars";
import type { Person } from "../demo-data";

const AVATAR_PX = { sm: 24, md: 36, lg: 44 };

/** A person's portrait, or their initials on their own tone when they have none. */
export function Avatar({ person, size = "md" }: { person: Person; size?: keyof typeof AVATAR_PX }) {
  const px = AVATAR_PX[size];
  const src = avatarFor(person);
  if (!src) {
    const monogram = monogramFor(person);
    return <span aria-hidden className="flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{ width: px, height: px, background: monogram.background, color: monogram.ink, fontSize: Math.round(px * 0.36) }}>{monogram.initials}</span>;
  }
  return (
    <Image
      src={src}
      alt=""
      width={px}
      height={px}
      unoptimized
      className="shrink-0 rounded-full"
      style={{ width: px, height: px }}
    />
  );
}
