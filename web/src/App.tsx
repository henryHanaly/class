import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  formatPrice,
  newIdempotencyKey,
  type BookingResult,
  type Child,
  type ParentLookup,
  type Roster,
  type SimulatePayment,
  type TrialClass,
} from './api';

type View = 'parent' | 'review' | 'result' | 'roster';

type Attempt = {
  parentId: string;
  childId: string;
  classId: string;
  simulatePayment: SimulatePayment;
  childName: string;
  subject: string;
  startsAt: string;
  priceCents: number;
};

type Outcome =
  | { kind: 'ok'; result: BookingResult }
  | { kind: 'error'; code: string; message: string };

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const asOutcome = (e: unknown): Outcome =>
  e instanceof ApiError
    ? { kind: 'error', code: e.code, message: e.message }
    : { kind: 'error', code: 'UNKNOWN', message: String(e) };

export default function App() {
  const [view, setView] = useState<View>('parent');

  // ---- parent / booking state ----
  const [email, setEmail] = useState('alice@example.com');
  const [parent, setParent] = useState<ParentLookup | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const [classes, setClasses] = useState<TrialClass[]>([]);
  const [childId, setChildId] = useState('');
  const [classId, setClassId] = useState('');
  const [simulatePayment, setSimulatePayment] = useState<SimulatePayment>('success');
  const [booking, setBooking] = useState(false);

  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [raceResults, setRaceResults] = useState<{ label: string; text: string }[] | null>(null);

  const loadClasses = useCallback(() => {
    api.listClasses().then(setClasses).catch(() => setClasses([]));
  }, []);

  useEffect(loadClasses, [loadClasses]);

  const onLookup = async () => {
    setLookupError(null);
    setParent(null);
    try {
      const p = await api.lookupParent(email.trim());
      setParent(p);
      setChildId(p.children[0]?.id ?? '');
      loadClasses();
    } catch (e) {
      setLookupError(e instanceof ApiError ? e.message : String(e));
    }
  };

  const runBooking = async (a: Attempt) => {
    setBooking(true);
    setRaceResults(null);
    try {
      const result = await api.book(a, newIdempotencyKey());
      setOutcome({ kind: 'ok', result });
    } catch (e) {
      setOutcome(asOutcome(e));
    } finally {
      setBooking(false);
      setAttempt(a);
      setView('result');
      loadClasses();
    }
  };

  // Step 1 -> review screen. The actual POST /bookings (which runs the mock
  // payment) fires from "Confirm & pay" on the review screen.
  const onReview = () => {
    const child = parent?.children.find((c) => c.id === childId);
    const klass = classes.find((c) => c.id === classId);
    if (!parent || !child || !klass) return;
    setAttempt({
      parentId: parent.parentId,
      childId: child.id,
      classId: klass.id,
      simulatePayment,
      childName: child.name,
      subject: klass.subject,
      startsAt: klass.startsAt,
      priceCents: klass.priceCents,
    });
    setOutcome(null);
    setRaceResults(null);
    setView('review');
  };

  // Demo affordance: fire the seeded children at one class at once so the
  // last-seat race resolution (one confirmed, the rest rejected) is visible.
  const onFireConcurrent = async () => {
    if (!parent || !classId) return;
    setBooking(true);
    try {
      const targets = parent.children.slice(0, 6);
      const settled = await Promise.all(
        targets.map(async (c) => {
          try {
            const r = await api.book(
              { parentId: parent.parentId, childId: c.id, classId, simulatePayment: 'success' },
              newIdempotencyKey(),
            );
            return { label: c.name, text: r.status };
          } catch (e) {
            return { label: c.name, text: e instanceof ApiError ? e.code : String(e) };
          }
        }),
      );
      setOutcome(null);
      setAttempt(null);
      setRaceResults(settled);
      setView('result');
    } finally {
      setBooking(false);
      loadClasses();
    }
  };

  return (
    <main>
      <h1>Trial Booking</h1>
      <nav>
        <button onClick={() => setView('parent')} disabled={view === 'parent'}>
          Book a trial
        </button>
        <button onClick={() => setView('roster')} disabled={view === 'roster'}>
          Admin roster
        </button>
      </nav>

      {view === 'parent' && (
        <ParentView
          {...{
            email,
            setEmail,
            onLookup,
            lookupError,
            parent,
            classes,
            childId,
            setChildId,
            classId,
            setClassId,
            simulatePayment,
            setSimulatePayment,
            booking,
            onReview,
            onFireConcurrent,
          }}
        />
      )}

      {view === 'review' && attempt && (
        <ReviewView
          attempt={attempt}
          booking={booking}
          onConfirm={() => void runBooking(attempt)}
          onBack={() => setView('parent')}
        />
      )}

      {view === 'result' && (
        <ResultView
          outcome={outcome}
          attempt={attempt}
          raceResults={raceResults}
          onRetry={() => attempt && void runBooking({ ...attempt, simulatePayment: 'success' })}
          onBack={() => setView('parent')}
        />
      )}

      {view === 'roster' && <RosterView classes={classes} />}
    </main>
  );
}

// ---------------------------------------------------------------------------

type ParentViewProps = {
  email: string;
  setEmail: (v: string) => void;
  onLookup: () => void;
  lookupError: string | null;
  parent: ParentLookup | null;
  classes: TrialClass[];
  childId: string;
  setChildId: (v: string) => void;
  classId: string;
  setClassId: (v: string) => void;
  simulatePayment: SimulatePayment;
  setSimulatePayment: (v: SimulatePayment) => void;
  booking: boolean;
  onReview: () => void;
  onFireConcurrent: () => void;
};

function ParentView(p: ParentViewProps) {
  const canBook = !!p.parent && !!p.childId && !!p.classId && !p.booking;

  return (
    <section>
      <h2>1. Who are you?</h2>
      <div className="row">
        <input
          type="email"
          value={p.email}
          onChange={(e) => p.setEmail(e.target.value)}
          placeholder="alice@example.com"
        />
        <button onClick={p.onLookup}>Look up</button>
      </div>
      <p className="hint">
        Seeded: alice@example.com, bob@example.com, carol@example.com (3 children,
        no bookings yet)
      </p>
      {p.lookupError && <p className="error">{p.lookupError}</p>}

      {p.parent && (
        <>
          <p>
            Signed in as <strong>{p.parent.name}</strong>
          </p>

          <h2>2. Pick a child</h2>
          <select value={p.childId} onChange={(e) => p.setChildId(e.target.value)}>
            {p.parent.children.map((c: Child) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.grade ? ` (${c.grade})` : ''}
              </option>
            ))}
          </select>

          <h2>3. Pick a class</h2>
          <ul className="classes">
            {p.classes.map((c) => {
              const full = c.seatsLeft === 0;
              return (
                <li key={c.id} className={full ? 'full' : ''}>
                  <label>
                    <input
                      type="radio"
                      name="class"
                      value={c.id}
                      disabled={full}
                      checked={p.classId === c.id}
                      onChange={(e) => p.setClassId(e.target.value)}
                    />
                    <span>
                      {c.subject} — {fmtDate(c.startsAt)} —{' '}
                      <strong>{formatPrice(c.priceCents)}</strong> —{' '}
                      <strong>{c.seatsLeft}</strong>/{c.capacity} seats left
                      {full ? ' (full)' : ''}
                    </span>
                  </label>
                </li>
              );
            })}
            {p.classes.length === 0 && <li>No upcoming classes.</li>}
          </ul>

          <h2>4. Book</h2>
          <div className="row">
            <label>
              Payment (dev toggle):{' '}
              <select
                value={p.simulatePayment}
                onChange={(e) => p.setSimulatePayment(e.target.value as SimulatePayment)}
              >
                <option value="success">success</option>
                <option value="fail">fail</option>
              </select>
            </label>
          </div>
          <div className="row">
            <button onClick={p.onReview} disabled={!canBook}>
              Review &amp; book
            </button>
            <button
              onClick={p.onFireConcurrent}
              disabled={!p.parent || !p.classId || p.booking}
              title="Books every child of this parent into the selected class at once"
            >
              Fire concurrent bookings (demo)
            </button>
          </div>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

function ReviewView({
  attempt,
  booking,
  onConfirm,
  onBack,
}: {
  attempt: Attempt;
  booking: boolean;
  onConfirm: () => void;
  onBack: () => void;
}) {
  return (
    <section>
      <h2>Review &amp; pay</h2>
      <table>
        <tbody>
          <tr>
            <th>Child</th>
            <td>{attempt.childName}</td>
          </tr>
          <tr>
            <th>Class</th>
            <td>
              {attempt.subject} — {fmtDate(attempt.startsAt)}
            </td>
          </tr>
          <tr>
            <th>Price</th>
            <td>
              <strong>{formatPrice(attempt.priceCents)}</strong>
            </td>
          </tr>
          <tr>
            <th>Payment</th>
            <td>mock — will {attempt.simulatePayment === 'fail' ? 'fail' : 'succeed'}</td>
          </tr>
        </tbody>
      </table>
      <p className="hint">
        Clicking confirm sends <code>POST /bookings</code>, which claims the seat and
        runs the (mock) payment in one step.
      </p>
      <div className="row">
        <button onClick={onConfirm} disabled={booking}>
          {booking ? 'Processing…' : `Confirm & pay ${formatPrice(attempt.priceCents)}`}
        </button>
        <button onClick={onBack} disabled={booking}>
          Back
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

const messageFor = (o: Outcome, a: Attempt | null): string => {
  if (o.kind === 'ok') {
    return o.result.status === 'confirmed'
      ? `Booked — ${a?.childName ?? 'the child'} is confirmed for ${a?.subject ?? 'the class'}. Charged ${formatPrice(o.result.priceCents)}.`
      : "Payment didn't go through. Try again.";
  }
  switch (o.code) {
    case 'BOOKING_CLASS_FULL':
      return 'Sorry, that seat was just taken.';
    case 'BOOKING_DUPLICATE':
      return 'You already have a booking for this class.';
    case 'IDEMPOTENCY_IN_PROGRESS':
      return 'That request is still processing — try again in a moment.';
    case 'LOCK_TIMEOUT':
      return 'The system is busy right now. Please try again.';
    default:
      return o.message;
  }
};

function ResultView({
  outcome,
  attempt,
  raceResults,
  onRetry,
  onBack,
}: {
  outcome: Outcome | null;
  attempt: Attempt | null;
  raceResults: { label: string; text: string }[] | null;
  onRetry: () => void;
  onBack: () => void;
}) {
  const showRetry =
    outcome?.kind === 'ok' && outcome.result.status === 'payment_failed' && !!attempt;

  return (
    <section>
      <h2>Booking result</h2>

      {outcome && (
        <p
          className={
            outcome.kind === 'ok' && outcome.result.status === 'confirmed' ? 'ok' : 'error'
          }
        >
          {messageFor(outcome, attempt)}
        </p>
      )}

      {raceResults && (
        <>
          <p>Fired {raceResults.length} bookings at the same class:</p>
          <table>
            <thead>
              <tr>
                <th>Child</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {raceResults.map((r, i) => (
                <tr key={i}>
                  <td>{r.label}</td>
                  <td>{r.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">
            At most one <code>confirmed</code>; the rest come back{' '}
            <code>BOOKING_CLASS_FULL</code> or <code>BOOKING_DUPLICATE</code>.
          </p>
        </>
      )}

      <div className="row">
        {showRetry && <button onClick={onRetry}>Try again</button>}
        <button onClick={onBack}>Back</button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

function RosterView({ classes }: { classes: TrialClass[] }) {
  const [classId, setClassId] = useState('');
  const [roster, setRoster] = useState<Roster | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (id: string) => {
    setClassId(id);
    setRoster(null);
    setError(null);
    if (!id) return;
    try {
      setRoster(await api.roster(id));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <section>
      <h2>Admin roster</h2>
      <select value={classId} onChange={(e) => void load(e.target.value)}>
        <option value="">Pick a class…</option>
        {classes.map((c) => (
          <option key={c.id} value={c.id}>
            {c.subject} — {fmtDate(c.startsAt)}
          </option>
        ))}
      </select>

      {error && <p className="error">{error}</p>}

      {roster && (
        <>
          <h3>{roster.subject}</h3>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Grade</th>
                <th>Booked at</th>
              </tr>
            </thead>
            <tbody>
              {roster.students.map((s) => (
                <tr key={s.childId}>
                  <td>{s.name}</td>
                  <td>{s.grade ?? '—'}</td>
                  <td>{fmtDate(s.bookedAt)}</td>
                </tr>
              ))}
              {roster.students.length === 0 && (
                <tr>
                  <td colSpan={3}>No confirmed students yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
