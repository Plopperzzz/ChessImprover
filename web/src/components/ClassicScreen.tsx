import { ExternalLink } from 'lucide-react';

interface ClassicScreenProps {
  title: string;
  blurb: string;
  features: string[];
}

/**
 * Play vs Maia and Puzzles have not been rebuilt on this UI yet. Rather than
 * showing a screen that looks like the feature and isn't, they point at the
 * classic UI, which is still served in full at /legacy/ and still talks to the
 * same backend and the same database.
 */
export function ClassicScreen({ title, blurb, features }: ClassicScreenProps) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-2xl border border-line bg-surface p-6 text-fg shadow-xl">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">{blurb}</p>

        <ul className="mt-4 space-y-1.5">
          {features.map((feature) => (
            <li key={feature} className="flex gap-2 text-xs text-fg-muted">
              <span className="text-accent">•</span>
              <span>{feature}</span>
            </li>
          ))}
        </ul>

        <a
          href="/legacy/"
          className="mt-6 flex items-center justify-center gap-2 rounded-lg bg-accent-strong px-4 py-2.5 text-sm font-semibold text-on-accent transition-colors hover:bg-accent"
        >
          Open the classic UI
          <ExternalLink className="h-4 w-4" />
        </a>
        <p className="mt-2 text-center text-[11px] text-fg-subtle">
          Same server, same account, same database.
        </p>
      </div>
    </div>
  );
}
