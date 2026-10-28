import { createContext, useCallback, useContext, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface Request {
  title: string;
  description: string;
  action: string;
  destructive?: boolean;
}

const ConfirmContext = createContext<(r: Request) => Promise<boolean>>(async () => false);

/** `const confirm = useConfirm(); if (await confirm({...})) …` — an in-app replacement for window.confirm. */
export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null);
  const resolve = useRef<(ok: boolean) => void>(() => {});
  const confirm = useCallback(
    (r: Request) =>
      new Promise<boolean>((ok) => {
        resolve.current = ok;
        setRequest(r);
      }),
    [],
  );
  const close = (ok: boolean) => {
    resolve.current(ok);
    setRequest(null);
  };
  return (
    <ConfirmContext value={confirm}>
      {children}
      <AlertDialog open={request !== null} onOpenChange={(open) => !open && close(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{request?.title}</AlertDialogTitle>
            <AlertDialogDescription>{request?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction variant={request?.destructive ? "destructive" : "default"} onClick={() => close(true)}>
              {request?.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext>
  );
}
