/**
 * THE TIME DIAL.
 *
 * A fixed needle with the ribbon of stations travelling underneath it, like
 * tuning a radio — not a thumb sliding along a track. The difference matters:
 * a tuner puts "now" at a constant place on screen and moves the world past it,
 * which is the right metaphor for a machine that holds a place and moves through
 * time. It also means the readout never moves, so the year stays readable while
 * you drag.
 *
 * Each station shows its cache state, so the ribbon doubles as a map of what is
 * already generated. Lit stations are instant; dim ones will cost a wait.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RIBBON_WIDTH,
  STATIONS,
  parseYearInput,
  shortYear,
  splitYear,
  stationAtCentre,
  stationCentre,
  centreForYear,
  stationLeft,
  stationOrder,
  stationRunWidth,
  stationWidth,
} from '../lib/stations';
import type { SceneStatus } from '../lib/engine';
import { formatYear, getEraBand } from '../../lib/format';
import { eraAccent } from '../lib/eraField';

/**
 * How many stations either side of the needle are actually rendered.
 *
 * The ladder is ~280 rungs since the modern rung went annual, and every station
 * carries a tick, a dot and a rail — about 1,100 nodes if they all mount, walked
 * again on every single move of the dial. Only a screen's worth can ever be seen,
 * so the rest are replaced by two spacers of exactly the right width, which keeps
 * the flex flow (and therefore every offset) identical to rendering all of them.
 *
 * 70 covers 1,540px of minor ticks each side — comfortably past the edge of a
 * wide viewport, so nothing ever pops in at the fades.
 */
const WINDOW = 70;

interface Props {
  index: number;
  /** Jump to an arbitrary year typed by the user; snapped to the nearest station. */
  onYearEntry?: (year: number) => void;
  /** A typed year that is not on the ladder; the needle points between rungs. */
  exactYear?: number | null;
  onIndexChange: (index: number) => void;
  statusByYear: Map<number, SceneStatus>;
  onScrubbingChange: (scrubbing: boolean) => void;
  /** Station index of the held frame, if any. */
  pinIndex?: number | null;
  pinAccent?: string;
  /**
   * The seat counter from Portal: `n` increments once per station landed on and
   * `solid` records whether that station is one you already own. Used only to
   * key the contact spark, so the dial never has to ask the engine anything.
   */
  seat?: { n: number; solid: boolean };
  /** The two times selected for a postcard. */
  postcardYears?: readonly [number, number] | null;
}

/**
 * How many stations each era band occupies, keyed by the band's first station
 * index. A band label is absolutely positioned and nowrap, so without a width
 * bound a long name in a narrow band overruns into the next one — "INDUSTRIAL
 * REVOLUTION" spans 1800–1900, which is only two stations (108px), and it was
 * colliding with "EARLY MODERN ERA" next door.
 */
function bandWidths(): Map<number, number> {
  const widths = new Map<number, number>();
  let startIndex = 0;
  for (let i = 1; i <= STATIONS.length; i++) {
    const ended = i === STATIONS.length || getEraBand(STATIONS[i]!).id !== getEraBand(STATIONS[i - 1]!).id;
    if (ended) {
      // PIXELS, not a station count. Cells are three different widths now, so
      // count * SPACING is no longer the span of anything.
      widths.set(startIndex, stationRunWidth(startIndex, i - startIndex));
      startIndex = i;
    }
  }
  return widths;
}

const BAND_WIDTHS = bandWidths();

export function TimeDial({
  index,
  onYearEntry,
  exactYear = null,
  onIndexChange,
  statusByYear,
  onScrubbingChange,
  pinIndex = null,
  pinAccent = '#ffd166',
  seat = { n: 0, solid: false },
  postcardYears = null,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const drag = useRef<{ startX: number; startIndex: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  /**
   * Which side of zero a bare number means.
   *
   * The parser has always understood "500 BC" — but nothing on screen said so,
   * so the only way to reach the BC half of the ladder by typing was to already
   * know that letters were accepted. A visible toggle turns an invisible parsing
   * rule into a control, and reduces entry to digits.
   *
   * It is a DEFAULT, not an override: type "500 BC" and the text still wins, and
   * the toggle moves to match it. The control tells you how your digits will be
   * read, and never contradicts what you actually typed.
   */
  const [era, setEra] = useState<'BC' | 'AD'>('AD');
  const entryRef = useRef<HTMLInputElement>(null);
  /**
   * What is driving the ribbon. A mechanism is defined by what moves it, and one
   * duration could not tell a finger from an arrow key from a 3,000-year jump —
   * so the ribbon's transition is chosen per gesture (see .dial-ribbon[data-mode]).
   * The detent is the resting value, because a step is what most moves are.
   */
  const [mode, setMode] = useState<'drag' | 'step' | 'fly'>('step');

  useEffect(() => {
    if (typing) entryRef.current?.focus();
  }, [typing]);

  /** True when the text carries its own era or scale and the toggle must not interfere. */
  const draftIsExplicit = (text: string) =>
    /[a-z]/i.test(text);

  const commitTyped = () => {
    const raw = draft.trim();
    // Bare digits take their sign from the toggle; anything with letters in it
    // is parsed as written, because the user has said what they mean.
    const parsed =
      raw && !draftIsExplicit(raw) && era === 'BC'
        ? parseYearInput(`${raw} BC`)
        : parseYearInput(raw);
    setTyping(false);
    if (parsed === null) return;
    // A typed year does NOT route through commit() — the parent maps it to a
    // station and pushes a new `index` prop — so the coupling has to be decided
    // here or the ribbon would detent across the whole ladder. Typing a year is
    // a flight by intent, near or far.
    setMode('fly');
    onYearEntry?.(parsed);
  };

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    onScrubbingChange(dragging);
  }, [dragging, onScrubbingChange]);

  const commit = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(STATIONS.length - 1, next));
      // Decided before the move, from the gesture that caused it: a finger is
      // rigidly coupled, a jump of more than six stations coasts, anything else
      // detents. setMode is a no-op re-render when the mode is unchanged, which
      // is the common case, so this costs nothing on a drag.
      setMode(drag.current ? 'drag' : Math.abs(clamped - index) > 6 ? 'fly' : 'step');
      if (clamped !== index) onIndexChange(clamped);
    },
    [index, onIndexChange],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Ignore secondary buttons so right-click doesn't start a phantom drag.
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startIndex: index };
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    // Dragging left pulls later stations toward the needle → forward in time.
    // Ribbon PIXELS, not station counts. With three cell widths a fixed
    // stations-per-pixel gain would make the finger and the tick disagree the
    // moment a drag crossed a gear change — and every drag through the modern
    // rung crosses several.
    const travelled = stationCentre(d.startIndex) + (d.startX - e.clientX);
    commit(stationAtCentre(travelled));
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    // Back to the detent the moment the finger leaves, so the next arrow key or
    // wheel notch clicks instead of inheriting the drag's 70ms linear coupling.
    setMode('step');
    if ((e.currentTarget as HTMLElement).hasPointerCapture?.(e.pointerId)) {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    }
  };

  /**
   * role="slider" implies the full arrow/Home/End/PageUp/PageDown contract.
   * Portal.tsx handles Left/Right globally, but assistive tech drives a slider
   * with Up/Down and jumps with Home/End — without these, VoiceOver's "adjust
   * value" cannot move the dial at all even though it announces it as a slider.
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const jump = Math.max(1, Math.round(STATIONS.length / 12));
    const moves: Record<string, number> = {
      ArrowUp: 1,
      ArrowDown: -1,
      PageUp: jump,
      PageDown: -jump,
    };
    if (e.key === 'Home') {
      e.preventDefault();
      commit(0);
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      commit(STATIONS.length - 1);
      return;
    }
    const delta = moves[e.key];
    if (delta === undefined) return;
    e.preventDefault();
    commit(index + delta);
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const dominant = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(dominant) < 2) return;
    e.preventDefault();
    commit(index + (dominant > 0 ? 1 : -1));
  };

  /* The readout must agree with the caption, the URL and the prompt. It was
     reading the RUNG, so typing 2077 left the dial insisting on 2075 while
     everything else had already moved — the one place the old snap was still
     visible after the rest was fixed. */
  const year = exactYear ?? STATIONS[index]!;
  const accent = eraAccent(year);
  // Split once per render, not twice inside JSX: fig and unit must always come
  // from the same call so they can never disagree about which side of a
  // threshold the year is on.
  const { fig, unit } = splitYear(year);
  // stationCentre() is the single source of truth for where a tick sits, and
  // everything that must line up with one — the needle, the pin fiducial, the
  // comparison span, the drag — reads it rather than recomputing from a width.
  /* centreForYear() interpolates across whichever gap the year falls in, so an
     off-ladder year parks the ribbon between its two rungs instead of lying
     about being one of them. On a rung it returns exactly stationCentre(). */
  const offset = width / 2 - (exactYear === null ? stationCentre(index) : centreForYear(exactYear));

  // The mounted window. Clamped to the ends so the spacers never go negative.
  const first = Math.max(0, index - WINDOW);
  const last = Math.min(STATIONS.length, index + WINDOW + 1);

  return (
    <div className="dial">
      <div className="dial-readout">
        {typing ? (
          /**
           * Direct entry. The dial is a tuner — excellent for browsing, hopeless
           * for "take me to 1969" when that is 140 stations away. Typing accepts
           * any year with NO range limit and snaps to the nearest station, so the
           * ladder stays the cache's unit while the user is not bounded by it.
           */
          <form
            className="dial-entry"
            onSubmit={(e) => {
              e.preventDefault();
              commitTyped();
            }}
          >
            <input
              ref={entryRef}
              value={draft}
              onChange={(e) => {
                const v = e.target.value;
                setDraft(v);
                // Typed era wins and drags the toggle with it, so the control can
                // never sit there claiming AD while the field says 500 BC.
                if (/\bbce?\b/i.test(v) || /(years?\s*ago|\bbp\b|mya|myr|kya|thousand|million)/i.test(v)) {
                  setEra('BC');
                } else if (/\b(ad|ce)\b/i.test(v)) {
                  setEra('AD');
                }
              }}
              onBlur={commitTyped}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setTyping(false);
                }
              }}
              aria-label="Go to year — type digits and pick BC or AD, or write 66 million years ago"
              placeholder="1969"
              inputMode="numeric"
              spellCheck={false}
            />
            <div className="era-toggle" role="radiogroup" aria-label="Era">
              {(['BC', 'AD'] as const).map((e) => (
                <button
                  key={e}
                  type="button"
                  role="radio"
                  aria-checked={era === e}
                  tabIndex={era === e ? 0 : -1}
                  className={`era-opt${era === e ? ' era-opt--on' : ''}`}
                  /* onMouseDown, not onClick: the input's onBlur commits, and a
                     click would fire the commit before the era had changed —
                     the toggle would appear to do nothing on the first press. */
                  onMouseDown={(ev) => {
                    ev.preventDefault();
                    setEra(e);
                    entryRef.current?.focus();
                  }}
                  onKeyDown={(ev) => {
                    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
                      ev.preventDefault();
                      ev.stopPropagation();
                      setEra((cur) => (cur === 'BC' ? 'AD' : 'BC'));
                    }
                  }}
                >
                  {e}
                </button>
              ))}
            </div>
          </form>
        ) : (
          <button
            className="dial-year"
            /**
             * Click AND double-click both open it. Double-click alone was a
             * mouse-only affordance: the readout is a <button>, so a keyboard
             * user could focus and activate it and nothing whatsoever happened —
             * typing a year was simply not available to them.
             */
            onClick={() => {
              setDraft('');
              // Seeded from the year on screen, so stepping into the field deep
              // in BC and typing 500 means 500 BC — not a 2,500-year jump across
              // zero that nobody asked for.
              setEra(year < 0 ? 'BC' : 'AD');
              setTyping(true);
            }}
            title="Type any year — 1969, 500 BC, 66 mya"
            // The figure is cut at display size and the unit is a legend beside
            // it, which is two elements and two type sizes for one number — so
            // the button carries the whole prose string and the split never
            // reaches assistive tech as "66" followed by "MILLION YEARS AGO".
            aria-label={formatYear(year)}
          >
            <span className="fig">{fig}</span>
            <span className="unit">{unit}</span>
          </button>
        )}
        <span className="dial-era">{getEraBand(year).label}</span>
      </div>

      <div
        ref={trackRef}
        className={`dial-track${dragging ? ' dial-track--dragging' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        role="slider"
        tabIndex={0}
        aria-label="Temporal station"
        // Index-based, because the control steps by station, not by year. Using
        // calendar years here made assistive tech report a position that moved
        // in wildly uneven jumps (a 100-year step near a 5-year step).
        aria-valuemin={0}
        aria-valuemax={STATIONS.length - 1}
        aria-valuenow={index}
        aria-valuetext={`${formatYear(year)}, ${getEraBand(year).label}`}
      >
        <div
          className="dial-ribbon"
          data-mode={mode}
          // --pin-accent is published on the ribbon, not on the pinned station:
          // both the ghost needle's fiducial and the pinned dot's ring read it,
          // and they live in different subtrees.
          style={{ transform: `translateX(${offset}px)`, ['--pin-accent' as string]: pinAccent }}
        >
          {postcardYears?.map((postcardYear, markerIndex) => (
            <span
              className="dial-postcard-marker"
              data-marker={markerIndex === 0 ? 'A' : 'B'}
              key={`${markerIndex}:${postcardYear}`}
              style={{ left: centreForYear(postcardYear) }}
              aria-hidden="true"
            />
          ))}
          {/* The span being compared, drawn literally: the distance between the
              fixed live needle and this travelling one IS the temporal distance,
              already spatially exact, for 2px inside an existing control. */}
          {pinIndex !== null && pinIndex !== index && (
            <>
              <span
                className="dial-span"
                style={{
                  left: Math.min(stationCentre(pinIndex), stationCentre(index)),
                  width: Math.abs(stationCentre(index) - stationCentre(pinIndex)),
                  background: `linear-gradient(90deg, ${pinIndex < index ? pinAccent : eraAccent(year)}, ${pinIndex < index ? eraAccent(year) : pinAccent})`,
                }}
              />
              <span
                className="dial-ghost-needle"
                style={{ left: stationCentre(pinIndex), background: pinAccent }}
              />
            </>
          )}
          {/* LEFT SPACER. Exactly the width of the stations that were not
              mounted, so every offset — and therefore the needle, the pin
              fiducial and the span — is identical to rendering all 280. */}
          {first > 0 && (
            <span aria-hidden="true" style={{ flex: '0 0 auto', width: stationLeft(first) }} />
          )}
          {STATIONS.slice(first, last).map((stationYear, n) => {
            const i = first + n;
            const band = getEraBand(stationYear);
            const status = statusByYear.get(stationYear);
            const isEraStart = i === 0 || getEraBand(STATIONS[i - 1]!).id !== band.id;
            const distance = Math.abs(i - index);
            // One lookup, two uses (the attribute and the numeral gate).
            const order = stationOrder(i);
            return (
              <div
                key={stationYear}
                className={[
                  'dial-station',
                  i === index ? 'dial-station--active' : '',
                  i === pinIndex ? 'dial-station--pinned' : '',
                  isEraStart ? 'dial-station--era-start' : '',
                  status === 'ready' ? 'dial-station--ready' : '',
                  status && status !== 'ready' && status !== 'error' ? 'dial-station--pending' : '',
                  status === 'error' ? 'dial-station--error' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                data-order={order}
                // No inline opacity any more: the falloff was up to 146 animated
                // parts per needle move to express something that belongs to
                // what you look THROUGH — .dial-fade is the aperture now.
                // --band feeds the rail and the era division; the graduation
                // itself stays monochrome, because a scale in twenty-one
                // colours is a texture, not a hierarchy.
                style={{ width: stationWidth(i), ['--band' as string]: band.color }}
              >
                <span className="dial-tick" />
                <span className="dial-dot" />
                {/* The scale figures. Gated at RENDER time and not with
                    display:none — hidden nodes still cost DOM — so about six of
                    these exist at once instead of 146. */}
                {order !== 'minor' && distance <= 14 && (
                  <span className="dial-numeral" aria-hidden="true">
                    {shortYear(stationYear)}
                  </span>
                )}
                {isEraStart && (
                  <span
                    className="dial-band-label"
                    // Clip to the band's own span so a long name can never bleed
                    // into the neighbouring era's label. Half a cell comes off
                    // the top because the label now hangs off its own division
                    // at left: 50% rather than starting at the cell's edge.
                    style={{ maxWidth: (BAND_WIDTHS.get(i) ?? 46) - stationWidth(i) / 2 - 6 }}
                    title={band.label}
                  >
                    {band.label}
                  </span>
                )}
                {/* The era as a continuous field: each station paints its own
                    cell-width slice of the rail in its own --band, so the colour
                    changes at a boundary with no extra geometry anywhere. */}
                <span className="dial-rail" aria-hidden="true" />
              </div>
            );
          })}
          {last < STATIONS.length && (
            <span
              aria-hidden="true"
              style={{ flex: '0 0 auto', width: RIBBON_WIDTH - stationLeft(last) }}
            />
          )}
        </div>

        {/* Only `background` inline. An inline boxShadow would win over the
            stylesheet and take the needle's dispersion fringes with it. */}
        <div className="dial-needle" style={{ background: accent }} />
        {/* The contact closing, fired only when you land on a station you
            already own. Keyed on the seat counter so React remounts the node
            and the animation replays from the top — no a/b keyframe pair, and
            nothing to reset. It is decoration for a state that is also carried
            by the dot's shape, so it is hidden from assistive tech. */}
        {seat.solid && seat.n > 0 && <span className="dial-contact" key={seat.n} aria-hidden="true" />}
        <div className="dial-fade dial-fade--left" />
        <div className="dial-fade dial-fade--right" />
      </div>
    </div>
  );
}
