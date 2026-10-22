import Image from "next/image";
import { avatarFor } from "../avatars";
import type { Person } from "../demo-data";

const AVATAR_PX = { sm: 24, md: 36, lg: 44 };

export function Avatar({ person, size = "md" }: { person: Person; size?: "sm" | "md" | "lg" }) {
  const px = AVATAR_PX[size];
  return (
    <Image
      src={avatarFor(person)}
      alt=""
      width={px}
      height={px}
      unoptimized
      className="shrink-0 rounded-full"
      style={{ width: px, height: px }}
    />
  );
}
