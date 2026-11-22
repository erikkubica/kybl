/**
 * The details pane next to the list, with the handle that resizes it. It shows the selection
 * of one browser pane (the only one, or the active one with two panes).
 */
import { useState } from "react";
import { PreviewPane } from "../components/PreviewPane";
import { LS } from "../browser/types";
import type { Pane } from "../browser/usePane";
import type { Settings } from "../settings";
import type { Entry } from "../types";

/** the clipboard takes files on macOS only for now (see platform.rs) */
const IS_MAC = /Mac/.test(navigator.platform || navigator.userAgent);

const PREVIEW_MIN = 260;
const PREVIEW_MAX = 760;
const PREVIEW_DEFAULT = 336;

/** Whether the details pane is open and how wide it is, both kept between launches. */
export function usePreviewLayout(openKey: string, openByDefault = true) {
  const [previewOpen, setPreviewOpen] = useState(openByDefault ? LS.get(openKey) !== "0" : LS.get(openKey) === "1");
  const [previewWidth, setPreviewWidth] = useState(() => {
    const w = Number(LS.get("s3b.previewWidth"));
    return w >= PREVIEW_MIN && w <= PREVIEW_MAX ? w : PREVIEW_DEFAULT;
  });
  const togglePreview = () =>
    setPreviewOpen((o) => {
      LS.set(openKey, o ? "0" : "1");
      return !o;
    });
  return { previewOpen, setPreviewOpen, togglePreview, previewWidth, setPreviewWidth };
}

export type PreviewLayout = ReturnType<typeof usePreviewLayout>;

export function PreviewAside({
  pane,
  layout,
  settings,
  reloadIfShowing,
  onOpenFull,
}: {
  pane: Pane;
  layout: PreviewLayout;
  settings: Settings;
  reloadIfShowing: (profileId: string, bucket: string) => boolean;
  /** opens a document in the full-window editor */
  onOpenFull?: (e: Entry) => void;
}) {
  const { profile, bucket, ops, actions, sel } = pane;
  const { previewWidth, setPreviewWidth } = layout;
  if (!profile || bucket == null) return null;
  const selectedEntries = sel.selectedEntries;

  const startResize = (ev: React.MouseEvent) => {
    ev.preventDefault();
    const sx = ev.clientX;
    const sw = previewWidth;
    const max = () => Math.min(PREVIEW_MAX, Math.round(window.innerWidth * 0.6));
    let w = sw;
    document.body.classList.add("resizing-col");
    const move = (e: MouseEvent) => {
      w = Math.max(PREVIEW_MIN, Math.min(max(), sw + sx - e.clientX));
      setPreviewWidth(w);
    };
    const up = () => {
      document.body.classList.remove("resizing-col");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      LS.set("s3b.previewWidth", String(w));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const resizeBy = (delta: number) => {
    const w = Math.max(PREVIEW_MIN, Math.min(PREVIEW_MAX, previewWidth + delta));
    setPreviewWidth(w);
    LS.set("s3b.previewWidth", String(w));
  };

  return (
    <>
      <div
        className="pane-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize details pane"
        aria-valuenow={previewWidth}
        aria-valuemin={PREVIEW_MIN}
        aria-valuemax={PREVIEW_MAX}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onMouseDown={startResize}
        onDoubleClick={() => {
          setPreviewWidth(PREVIEW_DEFAULT);
          LS.set("s3b.previewWidth", String(PREVIEW_DEFAULT));
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") resizeBy(24);
          if (e.key === "ArrowRight") resizeBy(-24);
        }}
      />
      {/* Stopgap until PreviewPane takes the connection's capabilities: what it can't do is hidden
          here (share links, the S3 properties editor). */}
      <div className="preview-caps" data-no-share={pane.caps?.share === "none" || undefined} data-no-props={pane.caps?.metadata === "none" || undefined}>
      <PreviewPane
        defaultExpiry={settings.linkExpiry}
        profileId={profile.id}
        bucket={bucket}
        selection={selectedEntries}
        onCopyLink={(secs) => selectedEntries[0] && actions.copyLink(selectedEntries[0], secs)}
        onCopyText={actions.copyText}
        onDownload={pane.caps?.localPaths ? undefined : () => ops.downloadEntries(selectedEntries, pane.relBase)}
        onRename={() => selectedEntries[0] && ops.askRename(selectedEntries[0])}
        onMoveTo={() => actions.askMove(selectedEntries)}
        onDelete={() => ops.askDelete(selectedEntries)}
        onContext={actions.onContext}
        onChanged={() => reloadIfShowing(profile.id, bucket)}
        folderSize={pane.folderSizes.view}
        onCalcSize={(k) => actions.calcSizes([k])}
        onOpenFull={onOpenFull}
        onOpenExternal={(e) => void ops.openInApp(e)}
        onCopyFile={IS_MAC ? (e) => void ops.copyFile(e) : undefined}
      />
      </div>
    </>
  );
}
