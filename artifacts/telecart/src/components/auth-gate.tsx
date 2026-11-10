import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useUser } from "@clerk/react";
import { Link } from "wouter";
import { Lock } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type Ctx = { isSignedIn: boolean; isLoaded: boolean; requireAuth: (action: string) => boolean };
const AuthGateContext = createContext<Ctx>({ isSignedIn: false, isLoaded: false, requireAuth: () => false });

export function AuthGateProvider({ children }: { children: ReactNode }) {
  const { isSignedIn, isLoaded } = useUser();
  const [action, setAction] = useState<string | null>(null);
  const requireAuth = useCallback(
    (a: string) => {
      if (isSignedIn) return true;
      setAction(a);
      return false;
    },
    [isSignedIn],
  );
  return (
    <AuthGateContext.Provider value={{ isSignedIn: !!isSignedIn, isLoaded, requireAuth }}>
      {children}
      <Dialog open={!!action} onOpenChange={(o) => !o && setAction(null)}>
        <DialogContent className="sm:max-w-md" data-testid="dialog-sign-in-required">
          <DialogHeader>
            <div className="mb-2 grid h-11 w-11 place-items-center rounded-xl bg-signal-soft text-signal">
              <Lock className="h-5 w-5" />
            </div>
            <DialogTitle className="font-display text-xl">Sign in to {action}</DialogTitle>
            <DialogDescription>
              You are looking at the public preview. Nothing here is saved. Sign in to open your own private
              shop workspace — it starts empty and only you can see it.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" asChild onClick={() => setAction(null)}>
              <Link href="/sign-up" data-testid="link-gate-sign-up">Create shop</Link>
            </Button>
            <Button asChild onClick={() => setAction(null)}>
              <Link href="/sign-in" data-testid="link-gate-sign-in">Sign in</Link>
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </AuthGateContext.Provider>
  );
}

export const useAuthGate = () => useContext(AuthGateContext);
