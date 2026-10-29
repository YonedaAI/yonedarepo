// The theme choice (System, Light, Dark) as a radio group, in the account menu and in
// Account settings. The choice applies at once and is kept in this browser.
import { Monitor, Moon, Sun } from 'lucide-react';
import { useId } from 'react';
import { THEMES, type Theme, useTheme } from './theme';

const ICONS = { system: Monitor, light: Sun, dark: Moon } as const;

export function ThemePicker({ value, onChange }: { value?: Theme; onChange?: (t: Theme) => void }) {
  const [stored, write] = useTheme();
  const theme = value ?? stored;
  const name = useId();
  return (
    <fieldset className="theme-picker">
      <legend>Theme</legend>
      {THEMES.map(({ id, label }) => {
        const Icon = ICONS[id];
        return (
          <label key={id} className={theme === id ? 'checked' : ''}>
            <input
              type="radio"
              name={name}
              value={id}
              checked={theme === id}
              onChange={() => (onChange ?? write)(id)}
            />
            <Icon size={14} aria-hidden="true" />
            {label}
          </label>
        );
      })}
    </fieldset>
  );
}
