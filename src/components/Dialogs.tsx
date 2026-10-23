// 대화상자: 새 플레이리스트, 플레이리스트 정보 바꾸기, 삭제 확인.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { t, tk } from '../i18n';
import { useStore } from '../lib/store';
import type { Privacy } from '../lib/ytm/client';
import type { Track } from '../lib/ytm/types';
import { createPlaylist, renamePlaylist } from '../state/library';
import { closeDialog, dialogStore } from '../state/ui';

export function DialogHost() {
  const node = useStore(dialogStore, (s) => s);
  useEffect(() => {
    if (!node) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeDialog();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [node]);
  if (!node) return null;
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && closeDialog()}>
      {node}
    </div>
  );
}

function Frame({ title, children, onSubmit, submitLabel, busy, danger }: {
  title: string;
  children: ReactNode;
  onSubmit: () => void | Promise<void>;
  submitLabel: string;
  busy?: boolean;
  danger?: boolean;
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void onSubmit();
  };
  return (
    <form className="dialog" role="dialog" aria-modal="true" aria-label={title} onSubmit={submit}>
      <h2 className="dialog__title">{title}</h2>
      {children}
      <div className="dialog__actions">
        <button type="button" className="btn btn--quiet" onClick={closeDialog}>{t('취소')}</button>
        <button type="submit" className={danger ? 'btn btn--danger' : 'btn btn--primary'} disabled={busy}>
          {busy ? t('처리 중…') : submitLabel}
        </button>
      </div>
    </form>
  );
}

// 이름·설명은 표시만 해 두고 그릴 때 번역한다.
const PRIVACY: { value: Privacy; label: string; hint: string }[] = [
  { value: 'PRIVATE', label: tk('비공개'), hint: tk('나만 볼 수 있습니다') },
  { value: 'UNLISTED', label: tk('일부 공개'), hint: tk('링크가 있는 사람만 볼 수 있습니다') },
  { value: 'PUBLIC', label: tk('공개'), hint: tk('누구나 검색해서 볼 수 있습니다') },
];

export function NewPlaylistDialog({ tracks = [], onCreated }: { tracks?: Track[]; onCreated?: (id: string) => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [privacy, setPrivacy] = useState<Privacy>('PRIVATE');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const hint = PRIVACY.find((p) => p.value === privacy)?.hint;

  const submit = async () => {
    if (!title.trim()) {
      input.current?.focus();
      return;
    }
    setBusy(true);
    const id = await createPlaylist(title.trim(), description.trim(), privacy, tracks);
    setBusy(false);
    if (id) {
      closeDialog();
      onCreated?.(id);
    }
  };

  return (
    <Frame title={t('새 플레이리스트')} onSubmit={submit} submitLabel={tracks.length ? t('만들고 {n}곡 추가', { n: tracks.length }) : t('만들기')} busy={busy}>
      <label className="field">
        <span className="field__label">{t('이름')}</span>
        <input ref={input} className="field__input" value={title} maxLength={150} onChange={(e) => setTitle(e.target.value)} placeholder={t('예: 출근길')} />
      </label>
      <label className="field">
        <span className="field__label">{t('설명')}</span>
        <textarea className="field__input field__input--area" value={description} maxLength={5000} onChange={(e) => setDescription(e.target.value)} rows={3} />
      </label>
      <fieldset className="field">
        <legend className="field__label">{t('공개 범위')}</legend>
        <div className="segmented">
          {PRIVACY.map((p) => (
            <label key={p.value} className={`segmented__item${privacy === p.value ? ' is-on' : ''}`} data-tip={t(p.hint)}>
              <input type="radio" name="privacy" value={p.value} checked={privacy === p.value} onChange={() => setPrivacy(p.value)} />
              {t(p.label)}
            </label>
          ))}
        </div>
        <p className="field__hint">{hint && t(hint)}</p>
      </fieldset>
    </Frame>
  );
}

export function RenamePlaylistDialog({ playlistId, title: initial, description: initialDesc = '', onDone }: {
  playlistId: string;
  title: string;
  description?: string;
  onDone?: () => void;
}) {
  const [title, setTitle] = useState(initial);
  const [description, setDescription] = useState(initialDesc);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    const ok = await renamePlaylist(playlistId, title.trim(), description.trim());
    setBusy(false);
    if (ok) {
      closeDialog();
      onDone?.();
    }
  };
  return (
    <Frame title={t('플레이리스트 정보 바꾸기')} onSubmit={submit} submitLabel={t('저장')} busy={busy}>
      <label className="field">
        <span className="field__label">{t('이름')}</span>
        <input className="field__input" value={title} maxLength={150} autoFocus onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="field">
        <span className="field__label">{t('설명')}</span>
        <textarea className="field__input field__input--area" value={description} maxLength={5000} rows={3} onChange={(e) => setDescription(e.target.value)} />
      </label>
    </Frame>
  );
}

export function ConfirmDialog({ title, message, confirmLabel, onConfirm }: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => Promise<boolean | void> | boolean | void;
}) {
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const ok = await onConfirm();
    setBusy(false);
    if (ok !== false) closeDialog();
  };
  return (
    <Frame title={title} onSubmit={submit} submitLabel={confirmLabel} busy={busy} danger>
      <p className="dialog__message">{message}</p>
    </Frame>
  );
}
