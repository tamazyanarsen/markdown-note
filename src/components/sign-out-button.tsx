import { LogOutIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/auth";

export function SignOutButton({ className }: { className?: string }) {
  return (
    <form
      action={async () => {
        "use server";
        await signOut({ redirectTo: "/signin" });
      }}
    >
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        className={className ?? "w-full justify-start text-muted-foreground"}
      >
        <LogOutIcon />
        Выйти
      </Button>
    </form>
  );
}
