import { signOut } from "@/lib/auth";

export function SignOutButton({ className }: { className?: string }) {
  return (
    <form
      action={async () => {
        "use server";
        await signOut({ redirectTo: "/signin" });
      }}
    >
      <button
        type="submit"
        className={
          className ??
          "cursor-pointer rounded-md border border-border px-3 py-1.5 text-sm text-muted transition-colors hover:bg-surface"
        }
      >
        Выйти
      </button>
    </form>
  );
}
