/** The apps that open a type ("Open with ▸", "Edit with ▸", and the open guard's "is it the default?"). */
import { api, type AppChoice } from "../../core/api";

/**
 * Apps by type ("/" for folders, else the extension) for this session, so the submenu opens at
 * once the second time. A request still under way is shared; a failed one is asked again.
 */
const appCache = new Map<string, AppChoice[] | Promise<AppChoice[]>>();

const typeKey = (name: string, folder: boolean) => {
  if (folder) return "/";
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
};

export function appsFor(name: string, folder: boolean): AppChoice[] | Promise<AppChoice[]> {
  const k = typeKey(name, folder);
  const have = appCache.get(k);
  if (have) return have;
  const p = api.appsFor(name, folder).then(
    (list) => {
      appCache.set(k, list);
      return list;
    },
    (err) => {
      appCache.delete(k);
      throw err;
    },
  );
  appCache.set(k, p);
  return p;
}
