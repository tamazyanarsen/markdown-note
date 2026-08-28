import Link from "next/link";

import { Separator } from "@/components/ui/separator";

/** Подвал публичных страниц: заметки и папки, открытых по ссылке. */
export function PublicFooter() {
  return (
    <footer className="mt-12">
      <Separator />
      <Link
        href="/"
        className="mt-4 inline-block font-heading text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        md-note
      </Link>
    </footer>
  );
}
