import { toast } from "@/components/ui/toast";
import { HttpError } from "./api";

/** One wording for every failed action: what failed and the server's code. */
export function notifyError(action: string) {
  return (e: unknown) =>
    toast.add({
      title: `${action}: не удалось`,
      description: e instanceof HttpError ? `${e.code ?? `HTTP ${e.status}`}: ${e.message}` : String(e),
      type: "error",
    });
}
export const notifyDone = (title: string, description?: string) => toast.add({ title, description, type: "success" });
