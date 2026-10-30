// A principal where the app names who did something (history, changes, comments, commits):
// their picture and their name as this page's viewer may read it (see people.ts).
import { Avatar, avatarOf } from '../shell/Avatar';
import { usePeople } from './people';

export function Person({ principal, strong = false }: { principal: string; strong?: boolean }) {
  const people = usePeople();
  const name = people.principal(principal);
  return (
    <span className="person">
      <Avatar name={name} src={avatarOf(principal)} size={18} />
      {strong ? <strong>{name}</strong> : name}
    </span>
  );
}
