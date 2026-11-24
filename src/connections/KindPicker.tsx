/** "New connection": what kind of storage to add, grouped (cloud drives, object storage, servers). */
import { Icon } from "../Icons";
import { ProviderBadge } from "../components/Sidebar";
import { GROUPS, KINDS, type PickId } from "./kinds";
import { PHONE } from "./fields";

export function KindPicker({
  onPick,
  kybl,
  kyblFirst,
  onImport,
}: {
  onPick: (id: PickId) => void;
  kybl: boolean;
  kyblFirst: boolean;
  /** computers: bring saved sites over from another app instead */
  onImport?: () => void;
}) {
  return (
    <div className="modal-body kind-pick">
      {kybl && kyblFirst && (
        <button type="button" className="kybl-offer" onClick={() => onPick("kybl")}>
          <ProviderBadge provider="kybl" large />
          <span className="kybl-offer-text">
            <strong>Kybl Storage</strong>
            <em>Sign in with your browser. No keys to copy.</em>
          </span>
          <Icon name="chevron" size={14} />
        </button>
      )}
      {GROUPS.map((g) => {
        const kinds = KINDS.filter((k) => k.group === g.id && (k.id !== "kybl" || (kybl && !kyblFirst)) && (k.id !== "ssh" || !PHONE));
        return (
          <section key={g.id} className="kind-group" aria-labelledby={`kind-${g.id}`}>
            <h3 id={`kind-${g.id}`}>{g.label}</h3>
            <div className="kind-grid">
              {kinds.map((k) => (
                <button key={k.id} type="button" className="kind-tile" onClick={() => onPick(k.id)}>
                  <ProviderBadge provider={k.provider} large />
                  <span className="kind-text">
                    <strong>{k.label}</strong>
                    <em>{k.blurb}</em>
                  </span>
                </button>
              ))}
            </div>
          </section>
        );
      })}
      {onImport && (
        <div className="kind-import">
          <button type="button" className="link-btn" onClick={onImport}>
            Import connections…
          </button>
        </div>
      )}
    </div>
  );
}
