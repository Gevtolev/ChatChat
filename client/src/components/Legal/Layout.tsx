import { Link } from 'react-router-dom';
import { useLocalize } from '~/hooks';

/**
 * Shell for the legal pages.
 *
 * Reachable without an account on purpose — someone has to be able to read the
 * terms before agreeing to them, and a visitor who has not signed up is exactly
 * the reader these pages exist for.
 *
 * The document bodies are English-only rather than routed through
 * `useLocalize()`, unlike every other string in the client. A translated legal
 * text is a *different* legal text: it either has to be produced by someone
 * qualified in the target jurisdiction or it becomes a liability, and the
 * machine translation pipeline that fills the other locale files is neither.
 * The chrome around them — title, back link, dates — is localized normally.
 */
export default function LegalLayout({
  title,
  updated,
  incomplete,
  children,
}: {
  title: string;
  /** ISO date, rendered in the reader's locale. */
  updated: string;
  /** Renders the unfinished banner. Drop it once the placeholders are filled. */
  incomplete?: boolean;
  children: React.ReactNode;
}) {
  const localize = useLocalize();

  return (
    <div className="h-screen overflow-y-auto bg-surface-primary">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <Link
          to="/"
          className="text-sm text-text-secondary underline underline-offset-2 hover:text-text-primary"
        >
          {localize('com_ui_back_to_chat')}
        </Link>

        <h1 className="mt-8 text-3xl font-semibold text-text-primary">{title}</h1>
        <p className="mt-2 text-sm text-text-secondary">
          {localize('com_ui_legal_last_updated', {
            0: new Date(updated).toLocaleDateString(undefined, {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            }),
          })}
        </p>

        {incomplete === true && (
          <div
            role="alert"
            className="mt-6 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-text-primary"
          >
            {localize('com_ui_legal_draft_notice')}
          </div>
        )}

        <div className="legal-prose mt-10 space-y-8 text-sm leading-relaxed text-text-primary">
          {children}
        </div>
      </div>
    </div>
  );
}

/** A numbered section. Split out so the two documents cannot drift in spacing
 *  or heading level, which is the one thing that makes a legal page look
 *  untrustworthy at a glance. */
export function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium text-text-primary">{heading}</h2>
      {children}
    </section>
  );
}

export function P({ children }: { children: React.ReactNode }) {
  return <p className="text-text-secondary">{children}</p>;
}

export function List({ children }: { children: React.ReactNode }) {
  return (
    <ul className="list-disc space-y-1.5 pl-6 text-text-secondary marker:text-text-tertiary">
      {children}
    </ul>
  );
}

/** Marks a value that cannot be written until the operating entity is
 *  registered. Visually loud so it can never ship unnoticed. */
export function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-amber-500/20 px-1 font-mono text-[0.9em] text-text-primary">
      {children}
    </span>
  );
}
