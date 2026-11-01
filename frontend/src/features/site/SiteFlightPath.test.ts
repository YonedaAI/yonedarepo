// The home page's Flight Path: the words a reader gets, in flying order, and that the drawings
// stay decorative and the picture stays an example.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DIALS, FIXES, TALL, WIDE } from './flightPath';
import { SiteFlightPath } from './SiteFlightPath';
import { SiteHome } from './SiteHome';

const markup = renderToStaticMarkup(createElement(SiteFlightPath));
const text = markup.replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]+>/g, ' ');

describe('the Flight Path picture', () => {
  it('sits on the home page, directly under the hero', () => {
    const home = renderToStaticMarkup(createElement(SiteHome, { navigate: () => {} }));
    const flight = home.indexOf('id="flight-heading"');
    expect(flight).toBeGreaterThan(home.indexOf('id="hero-heading"'));
    expect(flight).toBeLessThan(home.indexOf('id="problems-heading"'));
  });

  it('names every fix in flying order, the go-around before the clearance', () => {
    expect(FIXES.map((fix) => fix.name)).toEqual([
      'Flight plan',
      'Takeoff',
      'Route',
      'Instruments',
      'Go-around',
      'Cleared to land',
      'Landed',
    ]);
    const places = FIXES.map((fix) => text.indexOf(fix.name));
    expect(places).not.toContain(-1);
    expect(places).toEqual([...places].sort((a, b) => a - b));
  });

  it('gives the instruments, the clearance and the black box as text', () => {
    for (const dial of DIALS) {
      expect(text).toContain(dial.name);
      expect(text).toContain(dial.value);
    }
    for (const word of ['Clearance', 'Cleared to land', 'Landing 41 went first', 'Black box']) {
      expect(text).toContain(word);
    }
  });

  it('marks what is not on prod yet, and the whole picture as an example', () => {
    expect(text).toContain('Example');
    const soon = FIXES.filter((fix) => fix.soon).map((fix) => fix.name);
    expect(soon).toEqual(['Flight plan']);
    expect(text.match(/Soon/g)).toHaveLength(2);
  });

  it('hides every drawing from screen readers and says no measurement', () => {
    const svgs = markup.match(/<svg[^>]*>/g) ?? [];
    expect(svgs.length).toBeGreaterThan(0);
    for (const svg of svgs) expect(svg).toContain('aria-hidden="true"');
    expect(text).not.toMatch(/%|\bReady\b|faster|teams/i);
  });

  it('flies one path that ends on the runway, through the go-around', () => {
    for (const shape of [WIDE, TALL]) {
      expect(shape.flown).toContain(shape.loop.slice(1));
      expect(shape.flown.endsWith(shape.main.split(' ').slice(-2).join(' '))).toBe(true);
    }
  });
});
