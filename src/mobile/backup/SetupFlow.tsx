/**
 * Setting a backup up: what (the camera roll or a folder), where (any connection, picked in the
 * same folder tree copies use), then how (folder names, which items, when it runs).
 */
import { useEffect, useState, type MutableRefObject } from "react";
import { backupApi, errMessage, errSummary, LOCAL_ID, type BackupPermission, type BackupSetDraft, type BackupSetStatus, type BackupSource } from "../../api";
import { Icon } from "../../Icons";
import { LocationPicker, locLabel, type Loc, type PickedLocation } from "../../jobs/LocationPicker";
import type { Toast } from "../../components/Dialogs";
import { HONEST, PermissionNote, Seg, Toggle, type Platform } from "./parts";

type Step = "source" | "dest" | "options";
const STEPS: Step[] = ["source", "dest", "options"];

export const TEMPLATES: { id: string; label: string; folders?: boolean }[] = [
  { id: "{yyyy}/{MM}/{name}", label: "Year and month" },
  { id: "{yyyy}/{MM}/{dd}/{name}", label: "Year, month and day" },
  { id: "{device}/{yyyy}/{MM}/{name}", label: "Phone name, then year and month" },
  { id: "{name}", label: "All in one folder" },
  { id: "{path}", label: "The same folders as on the phone", folders: true },
];

/** The namings that make sense for a source: "same folders" only for folders, the phone's name only for photos. */
export const templatesFor = (roll: boolean, keep?: string) =>
  TEMPLATES.filter((t) => t.id === keep || (roll ? !t.folders : t.id !== "{device}/{yyyy}/{MM}/{name}"));

/** How a template names a file: "phone/2026/11/IMG_0042.HEIC". */
export function example(template: string, prefix: string, roll: boolean): string {
  const d = new Date();
  const name = roll ? "IMG_0042.HEIC" : "Invoices/2026-11.pdf";
  const p2 = (x: number) => String(x).padStart(2, "0");
  const path = template
    .replace("{yyyy}", String(d.getFullYear()))
    .replace("{MM}", p2(d.getMonth() + 1))
    .replace("{dd}", p2(d.getDate()))
    .replace("{device}", "Phone")
    .replace("{path}", name)
    .replace("{name}", name.split("/").pop() ?? name);
  return prefix + path;
}

export function SetupFlow({
  platform,
  perm,
  onPerm,
  onManage,
  onDone,
  toast,
  stepBack,
  setTitle,
}: {
  platform: Platform;
  perm: BackupPermission | null;
  onPerm: (p: BackupPermission) => void;
  onManage: () => void;
  onDone: (s: BackupSetStatus) => void;
  toast: (kind: Toast["kind"], text: string) => void;
  /** set here: steps back inside the setup; false on its first step */
  stepBack: MutableRefObject<(() => boolean) | null>;
  setTitle: (t: string) => void;
}) {
  const [step, setStep] = useState<Step>("source");
  const [source, setSource] = useState<BackupSource | null>(null);
  const [dest, setDest] = useState<PickedLocation | null>(null);
  const [asking, setAsking] = useState(false);
  // "New folder" in the destination picker
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [opts, setOpts] = useState({
    template: TEMPLATES[0].id,
    includeVideos: true,
    livePhotoVideo: true,
    heic: "keep" as "keep" | "convertJpeg",
    edited: "current" as "current" | "original" | "both",
    onlyNew: false,
    wifiOnly: true,
    chargingOnly: false,
  });
  const set = <K extends keyof typeof opts>(k: K, v: (typeof opts)[K]) => setOpts((o) => ({ ...o, [k]: v }));
  const roll = source?.type === "cameraRoll";
  const ios = platform === "ios";

  stepBack.current = () => {
    const i = STEPS.indexOf(step);
    if (i <= 0) return false;
    setStep(STEPS[i - 1]);
    return true;
  };
  useEffect(() => setTitle(`New backup · ${STEPS.indexOf(step) + 1} of 3`), [step, setTitle]);

  const pickRoll = async () => {
    let p = perm;
    if (p?.photos === "notDetermined") {
      setAsking(true);
      try {
        p = await backupApi.requestPermission();
        onPerm(p);
      } catch (e) {
        toast("error", errSummary(errMessage(e)));
      } finally {
        setAsking(false);
      }
    }
    // without any access there is nothing to back up yet: the note says how to fix it
    if (p?.photos === "denied" || p?.photos === "notDetermined") return;
    setSource({ type: "cameraRoll" });
    set("template", TEMPLATES[0].id);
    setStep("dest");
  };
  const pickFolder = async () => {
    try {
      const s = await backupApi.pickFolder();
      if (!s) return;
      setSource(s);
      set("template", "{path}");
      setStep("dest");
    } catch (e) {
      toast("error", `Couldn't open the folder picker. ${errSummary(errMessage(e))}`);
    }
  };

  const start = async () => {
    if (!source || !dest) return;
    setSaving(true);
    const draft: BackupSetDraft = {
      id: "",
      source,
      profileId: dest.profileId,
      root: dest.root,
      destPrefix: dest.dir,
      destLabel: locLabel(dest),
      template: opts.template,
      includeVideos: opts.includeVideos,
      livePhotoVideo: opts.livePhotoVideo,
      heic: opts.heic,
      edited: opts.edited,
      wifiOnly: opts.wifiOnly,
      chargingOnly: opts.chargingOnly,
      since: opts.onlyNew ? Date.now() : null,
      enabled: true,
    };
    try {
      const st = await backupApi.save(draft);
      onDone(st);
      backupApi.runNow(st.set.id).catch((e) => toast("error", `Couldn't start the backup. ${errSummary(errMessage(e))}`));
    } catch (e) {
      toast("error", `Couldn't set up the backup. ${errSummary(errMessage(e))}`);
      setSaving(false);
    }
  };

  if (step === "source")
    return (
      <div className="m-scroll bk-body">
        <p className="bk-lead">What should Kybl back up?</p>
        <ul className="m-group">
          <li>
            <button className="m-setting-row bk-choice" onClick={() => void pickRoll()} disabled={asking}>
              <span className="bk-ico roll big">
                <Icon name="image" size={22} />
              </span>
              <span className="m-grow">
                Camera roll
                <small className="m-sub">{asking ? "Asking for access…" : "Photos and videos on this phone"}</small>
              </span>
              <Icon name="chevron" size={13} className="m-chev" />
            </button>
          </li>
          <li>
            <button className="m-setting-row bk-choice" onClick={() => void pickFolder()}>
              <span className="bk-ico folder big">
                <Icon name="folder" size={22} />
              </span>
              <span className="m-grow">
                {ios ? "A folder in Files" : "A folder on this phone"}
                <small className="m-sub">{ios ? "Any folder the Files app shows" : "Documents, downloads, recordings…"}</small>
              </span>
              <Icon name="chevron" size={13} className="m-chev" />
            </button>
          </li>
        </ul>
        {perm && (perm.photos === "denied" || perm.photos === "limited") && (
          <PermissionNote perm={perm} platform={platform} onRequest={() => void pickRoll()} onManage={onManage} />
        )}
        <p className="m-foot">{HONEST}</p>
      </div>
    );

  if (step === "dest")
    return (
      <>
        <div className="bk-body bk-dest">
          <div className="bk-dest-head">
            <p className="bk-lead">Where should it go?</p>
            <button className="m-text-btn" onClick={() => setCreating(true)} disabled={creating || !dest || dest.profileId === LOCAL_ID}>
              <Icon name="folder-plus" size={16} /> New folder
            </button>
          </div>
          <LocationPicker
            value={dest}
            onChange={setDest}
            creating={creating}
            onCreatingDone={() => setCreating(false)}
            blocked={(l: Loc) => (l.profileId === LOCAL_ID ? "Backups go to one of your connections, not to this phone." : null)}
          />
        </div>
        <nav className="m-actionbar bk-bar-bottom">
          <button className="btn btn-primary m-big-btn" disabled={!dest || dest.profileId === LOCAL_ID} onClick={() => setStep("options")}>
            {dest && dest.profileId !== LOCAL_ID ? `Back up to ${locLabel(dest)}` : "Choose a folder"}
          </button>
        </nav>
      </>
    );

  const templates = templatesFor(roll);
  return (
    <>
      <div className="m-scroll bk-body">
        <div className="bk-summary">
          <div>
            <small>From</small>
            <span>{roll ? "Camera roll" : source && "label" in source ? source.label : "Folder"}</span>
          </div>
          <div>
            <small>To</small>
            <span>{dest ? locLabel(dest) : ""}</span>
          </div>
        </div>
        {roll && perm?.photos === "limited" && <PermissionNote perm={perm} platform={platform} onRequest={() => {}} onManage={onManage} />}

        <h2 className="m-section">Folders</h2>
        <ul className="m-group" role="radiogroup" aria-label="Folders">
          {templates.map((t) => (
            <li key={t.id}>
              <button className="m-setting-row" role="radio" aria-checked={opts.template === t.id} onClick={() => set("template", t.id)}>
                <span className="m-grow">
                  {t.label}
                  <small className="m-sub bk-path">{example(t.id, dest?.dir ?? "", roll)}</small>
                </span>
                <span className={`bk-radio ${opts.template === t.id ? "on" : ""}`} aria-hidden="true">
                  {opts.template === t.id && <Icon name="check" size={14} />}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className="m-hint bk-hint">A different file that has the same name gets a number, like “IMG_0042 (2).HEIC”.</p>

        {roll && (
          <>
            <h2 className="m-section">What to back up</h2>
            <ul className="m-group">
              <Toggle label="Videos" on={opts.includeVideos} set={(v) => set("includeVideos", v)} />
              {ios && <Toggle label="Live Photo videos" sub="The short clip that goes with a Live Photo" on={opts.livePhotoVideo} set={(v) => set("livePhotoVideo", v)} />}
              {ios && <Toggle label="Save HEIC photos as JPEG" sub="Easier to open on other devices; a little larger" on={opts.heic === "convertJpeg"} set={(v) => set("heic", v ? "convertJpeg" : "keep")} />}
            </ul>
            {ios && (
              <>
                <h2 className="m-section">Edited photos</h2>
                <div className="m-group m-pad">
                  <Seg
                    label="Edited photos"
                    value={opts.edited}
                    set={(v) => set("edited", v)}
                    options={[
                      { id: "current", label: "As edited" },
                      { id: "original", label: "Original" },
                      { id: "both", label: "Both" },
                    ]}
                  />
                </div>
              </>
            )}
          </>
        )}

        <h2 className="m-section">Start with</h2>
        <div className="m-group m-pad">
          <Seg
            label="Start with"
            value={opts.onlyNew ? "new" : "all"}
            set={(v) => set("onlyNew", v === "new")}
            options={[
              { id: "all", label: roll ? "All photos" : "All files" },
              { id: "new", label: "Only new from now" },
            ]}
          />
          <p className="m-hint">
            {opts.onlyNew
              ? `Only ${roll ? "photos and videos" : "files"} added from now on are backed up.`
              : "The first backup can take a while. It carries on where it stopped each time it runs."}
          </p>
        </div>

        <h2 className="m-section">When</h2>
        <ul className="m-group">
          <Toggle label="Wi-Fi only" sub="Waits for Wi-Fi instead of using mobile data" on={opts.wifiOnly} set={(v) => set("wifiOnly", v)} />
          <Toggle label="Only while charging" sub="Backups in the background wait for the charger" on={opts.chargingOnly} set={(v) => set("chargingOnly", v)} />
        </ul>
        <p className="m-foot">{HONEST}</p>
      </div>
      <nav className="m-actionbar bk-bar-bottom">
        <button className="btn btn-primary m-big-btn" disabled={saving || !source || !dest} onClick={() => void start()}>
          <Icon name="upload" size={16} /> {saving ? "Starting…" : "Start backup"}
        </button>
      </nav>
    </>
  );
}
