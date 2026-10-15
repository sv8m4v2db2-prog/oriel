// Settings › Application (desktop app only): quick search shortcut, Dock badge, session
// restoration and spell checking. Values live in the app (config.json), not on the server.
import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { Switch } from '@mantine/core';
import { toast } from '../lib/ui';
import { desktop, type DesktopPrefs } from '../lib/desktop';
import { Skeleton } from '../components/common';
import { acceleratorFromEvent, acceleratorLabel } from './accelerator';
import './desktop.css';

export function DesktopSettings() {
  const [prefs, setPrefs] = useState<DesktopPrefs | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void desktop?.getPrefs?.().then((p) => alive && setPrefs(p)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const update = useCallback(async (patch: Partial<DesktopPrefs>) => {
    setError(null);
    try {
      const res = await desktop?.setPrefs?.(patch);
      if (!res) return;
      setPrefs(res.prefs);
      if (!res.ok) setError(res.error ?? 'Réglage refusé.');
      else toast.success('Préférence enregistrée');
    } catch {
      setError('Réglage refusé.');
    }
  }, []);

  if (!prefs) return <Skeleton height={160} />;
  const mac = prefs.platform === 'darwin';

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!capturing) return;
    e.preventDefault();
    if (e.key === 'Escape') {
      setCapturing(false);
      return;
    }
    const accelerator = acceleratorFromEvent(e.nativeEvent);
    if (!accelerator) return;
    setCapturing(false);
    void update({ quickSearchShortcut: accelerator });
  };

  const toggleLanguage = (code: string) => {
    const current = new Set(prefs.spellLanguages ?? []);
    if (current.has(code)) current.delete(code);
    else current.add(code);
    if (current.size > 0) void update({ spellLanguages: [...current] });
  };

  return (
    <>
      <h1 className="settings__title">Application</h1>
      <p className="desktop-note">Ces réglages sont propres à cet ordinateur.</p>

      <section className="settings-section">
        <h2 className="settings-section__title">Recherche rapide</h2>
        <p className="settings-section__desc">
          Un raccourci système ouvre une petite fenêtre de recherche, même quand Oriel est en arrière-plan.
        </p>
        <div className="settings-section__body">
          <div className="collab-switch-row">
            <span>Activer le raccourci global</span>
            <Switch
              checked={prefs.quickSearchEnabled}
              onChange={(e) => void update({ quickSearchEnabled: e.currentTarget.checked })}
              aria-label="Activer la recherche rapide"
            />
          </div>
          <div className="collab-switch-row">
            <span>Raccourci</span>
            <button
              type="button"
              className="btn btn--secondary desktop-shortcut"
              disabled={!prefs.quickSearchEnabled}
              onClick={() => setCapturing((v) => !v)}
              onKeyDown={onKeyDown}
              onBlur={() => setCapturing(false)}
            >
              {capturing ? 'Tapez le raccourci…' : acceleratorLabel(prefs.quickSearchShortcut)}
            </button>
          </div>
          {error && (
            <p className="desktop-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </section>

      <section className="settings-section">
        <h2 className="settings-section__title">Icône du Dock</h2>
        <div className="settings-section__body">
          <div className="collab-switch-row">
            <span>Afficher le nombre de notifications non lues</span>
            <Switch
              checked={prefs.dockBadge}
              onChange={(e) => void update({ dockBadge: e.currentTarget.checked })}
              aria-label="Afficher la pastille du Dock"
            />
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2 className="settings-section__title">Onglets</h2>
        <div className="settings-section__body">
          <div className="collab-switch-row">
            <span>Rouvrir les fenêtres et onglets au lancement</span>
            <Switch
              checked={prefs.restoreSession}
              onChange={(e) => void update({ restoreSession: e.currentTarget.checked })}
              aria-label="Restaurer les onglets au lancement"
            />
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2 className="settings-section__title">Orthographe</h2>
        <div className="settings-section__body">
          <div className="collab-switch-row">
            <span>Vérifier l’orthographe pendant la saisie</span>
            <Switch
              checked={prefs.spellcheck}
              onChange={(e) => void update({ spellcheck: e.currentTarget.checked })}
              aria-label="Vérifier l’orthographe"
            />
          </div>
          {mac ? (
            <p className="desktop-note">
              Sur macOS, la langue est détectée automatiquement par le correcteur du système. Les dictionnaires se
              règlent dans Réglages Système › Clavier › Dictionnaire.
            </p>
          ) : (
            prefs.availableSpellLanguages.length > 0 && (
              <div className="desktop-languages" role="group" aria-label="Langues du correcteur">
                {prefs.availableSpellLanguages.map((code) => (
                  <label key={code} className="desktop-language">
                    <input
                      type="checkbox"
                      checked={prefs.spellLanguages?.includes(code) ?? false}
                      onChange={() => toggleLanguage(code)}
                    />
                    {code}
                  </label>
                ))}
              </div>
            )
          )}
        </div>
      </section>
    </>
  );
}
