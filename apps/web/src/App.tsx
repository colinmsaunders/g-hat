import { useEffect, useRef, useState } from "react";
import {
  alphabet,
  bounds,
  command,
  encode,
  type Identity,
  type Post,
  type Page,
} from "@geohash-chat/shared";
import { api, config, ensureGuest, sessionKey } from "./api";
import { Auth } from "./Auth";
import { freshPostingLocation } from "./location";
const places = [
  { name: "San Francisco", room: "9q8yy", label: "Bayside conversations" },
  { name: "New York", room: "dr5ru", label: "The city, in conversation" },
  { name: "London", room: "gcpvj", label: "Across the pond" },
  { name: "Tokyo", room: "xn76u", label: "A different time zone" },
];
const levels = [
  "",
  "A corner of the world",
  "A region",
  "A city & its neighbors",
  "Around town",
  "A neighborhood",
  "A few blocks",
  "Your street",
  "A little closer",
];
function initialRoom() {
  const path = location.pathname.slice(1).replace(/\/$/, "");
  return /^[0-9bcdefghjkmnpqrstuvwxyz]{1,8}$/.test(path) ? path : "";
}
export default function App() {
  const [room, setRoom] = useState(initialRoom);
  const [user, setUser] = useState<Identity>();
  const [messages, setMessages] = useState<Post[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [draft, setDraft] = useState("");
  const [join, setJoin] = useState("");
  const [postedRoom, setPostedRoom] = useState<string>();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [auth, setAuth] = useState(false);
  const [help, setHelp] = useState(false);
  const [locating, setLocating] = useState(false);
  const [historyPage, setHistoryPage] = useState(false);
  const historyMode = useRef(false);
  const currentRoom = useRef(room);
  currentRoom.current = room;
  const end = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  function go(next: string) {
    history.pushState({}, "", `/${next}`);
    historyMode.current = false;
    setHistoryPage(false);
    setRoom(next);
    setNotice("");
    setError("");
  }
  useEffect(() => {
    const handler = () => setRoom(initialRoom());
    window.addEventListener("popstate", handler);
    ensureGuest()
      .then(setUser)
      .catch((e) => setError(e.message));
    if (!room) locate();
    return () => window.removeEventListener("popstate", handler);
  }, []);
  useEffect(() => {
    if (!room) return;
    const serial = ++generation.current;
    let stopped = false;
    historyMode.current = false;
    setHistoryPage(false);
    setMessages([]);
    setCursor(undefined);
    setLoading(true);
    async function refresh() {
      try {
        const page = await api<Page>(`/rooms/${room}/messages`);
        if (stopped || serial !== generation.current || historyMode.current)
          return;
        setMessages(page.posts);
        setCursor(page.cursor);
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      } finally {
        if (!stopped) setLoading(false);
      }
    }
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden && !historyMode.current) void refresh();
    }, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [room]);
  async function locate() {
    setLocating(true);
    setNotice("Finding a conversation near you…");
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation
          ? navigator.geolocation.getCurrentPosition(resolve, reject, {
              timeout: 10000,
              maximumAge: 300000,
            })
          : reject(Error("Location unavailable")),
      );
      const hash = encode(pos.coords.latitude, pos.coords.longitude);
      const result = await api<{ room: string }>(
        `/rooms/suggest?geohash=${hash}`,
      );
      go(result.room);
      setNotice(
        "Found your area. Read anywhere; posts use your current reported location.",
      );
    } catch {
      setNotice(
        "Location is unavailable. Choose a place below or enter a geohash to get started.",
      );
    } finally {
      setLocating(false);
    }
  }
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!room || !draft.trim() || sending) return;
    setError("");
    try {
      const cmd = command(draft.trim(), room);
      if (cmd) {
        if (cmd.kind === "go") go(cmd.room);
        if (cmd.kind === "help") setHelp(true);
        if (cmd.kind === "locate") void locate();
        if (cmd.kind === "name") {
          const updated = await api<Identity>("/me", {
            method: "PATCH",
            body: JSON.stringify({ name: cmd.name }),
          });
          setUser(updated);
          localStorage.setItem("geohash.chat.name", cmd.name);
        }
        setDraft("");
        return;
      }
      setSending(true);
      const location = await freshPostingLocation();
      const result = await api<Post>("/messages", {
        method: "POST",
        body: JSON.stringify({
          content: draft,
          location,
        }),
      });
      setDraft("");
      setPostedRoom(result.originGeohash);
      setNotice(
        `Posted from #${result.originGeohash}. Your viewing room does not determine where you post.`,
      );
      if (
        currentRoom.current &&
        result.originGeohash.startsWith(currentRoom.current) &&
        !historyMode.current
      ) {
        setMessages((old) =>
          [
            result,
            ...old.filter(
              (m) => m.postId.slice(0, 2) !== result.postId.slice(0, 2),
            ),
          ].slice(0, 50),
        );
        setTimeout(
          () =>
            end.current?.scrollIntoView({
              behavior: "smooth",
              block: "nearest",
            }),
          30,
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  async function remove(m: Post) {
    try {
      await api(`/messages/${m.postId}?originGeohash=${m.originGeohash}`, {
        method: "DELETE",
      });
      setMessages((old) => old.filter((x) => x.postId !== m.postId));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function report(m: Post) {
    const reason = window.prompt(
      "What should a moderator know about this message?",
    );
    if (!reason) return;
    try {
      await api(`/messages/${m.postId}/reports`, {
        method: "POST",
        body: JSON.stringify({ reason, originGeohash: m.originGeohash }),
      });
      setNotice("Report sent for moderator review.");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function older() {
    const destination = room;
    try {
      const page = await api<Page>(
        `/rooms/${room}/messages?cursor=${encodeURIComponent(cursor!)}`,
      );
      if (currentRoom.current !== destination) return;
      historyMode.current = true;
      setHistoryPage(true);
      setMessages(page.posts);
      setCursor(page.cursor);
      setNotice("Browsing older messages. Return to live to see new messages.");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const box = room ? bounds(room) : undefined;
  const sorted = [...messages].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) ||
      a.postId.localeCompare(b.postId),
  );
  return (
    <div className="shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            history.pushState({}, "", "/");
            setRoom("");
          }}
        >
          <span className="brand-icon">⌗</span>geohash<span>.chat</span>
        </a>
        <div className="sidebar-intro">
          Good conversations
          <br />
          start somewhere.
        </div>
        <button className="locate-button" onClick={locate} disabled={locating}>
          <span>⌖</span>
          {locating ? "Finding your place…" : "Find my neighborhood"}
          <span>↗</span>
        </button>
        <div className="nav-label">EXPLORE THE WORLD</div>
        <nav>
          {places.map((p) => (
            <button
              key={p.room}
              className={`place ${room === p.room ? "selected" : ""}`}
              onClick={() => go(p.room)}
            >
              <span className="place-dot">↗</span>
              <span>
                <strong>{p.name}</strong>
                <small>{p.label}</small>
              </span>
              <code>{p.room}</code>
            </button>
          ))}
        </nav>
        <form
          className="join"
          onSubmit={(e) => {
            e.preventDefault();
            if (/^[0-9bcdefghjkmnpqrstuvwxyz]{1,8}$/.test(join.toLowerCase()))
              go(join.toLowerCase());
            else setError("Enter a valid geohash of 1–8 characters.");
          }}
        >
          <label htmlFor="join-room">GO SOMEWHERE SPECIFIC</label>
          <div>
            <input
              id="join-room"
              placeholder="Enter a geohash"
              value={join}
              maxLength={8}
              onChange={(e) => setJoin(e.target.value)}
            />
            <button aria-label="Join room">→</button>
          </div>
        </form>
        <div className="sidebar-bottom">
          <span className="avatar">
            {user?.name.slice(0, 1).toUpperCase() ?? "?"}
          </span>
          <div>
            <strong>{user?.name ?? "Connecting…"}</strong>
            <small>
              {user?.id.startsWith("guest:")
                ? "Just visiting · Guest"
                : "Member"}
            </small>
          </div>
          {user?.id.startsWith("user:") ? (
            <button
              className="text-button"
              onClick={() => {
                localStorage.removeItem(sessionKey);
                ensureGuest()
                  .then(setUser)
                  .catch((e) => setError(e.message));
              }}
            >
              Sign out
            </button>
          ) : (
            <button className="text-button" onClick={() => setAuth(true)}>
              Sign in
            </button>
          )}
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>
            <i className="live-dot" /> A little more local. A little more human.
          </span>
          <button className="text-button" onClick={() => setHelp(true)}>
            How it works <span>↗</span>
          </button>
        </header>
        <section className="room-heading">
          <div>
            <div className="eyebrow">
              {room ? "YOU ARE VIEWING" : "YOUR WORLD, IN CONVERSATION"}
            </div>
            <h1>
              {room ? (
                <>
                  <span className="hash">#</span>
                  {room}
                </>
              ) : (
                "Every place has a story."
              )}
            </h1>
            <p>
              {room
                ? `${levels[room.length]}. Everyone is welcome.`
                : "Find your people, a few blocks away or a world apart."}
            </p>
          </div>
          {room && (
            <div className="precision">
              <span>ROOM PRECISION</span>
              <div>
                {Array.from({ length: 8 }, (_, i) => (
                  <i key={i} className={i < room.length ? "filled" : ""} />
                ))}
              </div>
              <small>
                {room.length} of 8 · {levels[room.length]}
              </small>
            </div>
          )}
        </section>
        {(notice || config.local) && (
          <div className="notice" role="status">
            {notice ||
              (config.local
                ? "Local playground · Messages reset when the API restarts."
                : "")}
          </div>
        )}
        {postedRoom && (
          <button className="pill" onClick={() => go(postedRoom)}>
            View your post’s room #{postedRoom} ↗
          </button>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {room ? (
          <>
            <section className="room-tools">
              <div className="breadcrumbs">
                {room.split("").map((_, i) => (
                  <button key={i} onClick={() => go(room.slice(0, i + 1))}>
                    {room.slice(0, i + 1)}
                    {i < room.length - 1 && <span> / </span>}
                  </button>
                ))}
              </div>
              <button
                className="pill"
                disabled={room.length === 1}
                onClick={() => go(room.slice(0, -1))}
              >
                − Zoom out
              </button>
            </section>
            <div className="content">
              <section className="chat-panel" aria-label="Room conversation">
                <div className="chat-top">
                  <strong>
                    The conversation <span>{messages.length}</span>
                  </strong>
                  <small>
                    <i className="live-dot" />{" "}
                    {historyPage ? "History paused" : "Updates every 5s"}
                  </small>
                </div>
                <div className="message-scroll" aria-live="polite">
                  {historyPage && (
                    <button
                      className="older"
                      onClick={() => {
                        historyMode.current = false;
                        setHistoryPage(false);
                        setNotice("Returning to live messages…");
                      }}
                    >
                      Return to live ↓
                    </button>
                  )}
                  {cursor && (
                    <button className="older" onClick={older}>
                      View older messages ↑
                    </button>
                  )}
                  {loading ? (
                    <div className="empty">
                      <div className="empty-symbol">⌗</div>
                      <h2>Finding the conversation…</h2>
                    </div>
                  ) : !messages.length ? (
                    <div className="empty">
                      <div className="empty-symbol">⌗</div>
                      <span className="eyebrow">
                        A NEW CONVERSATION STARTS HERE
                      </span>
                      <h2>Discover what’s happening here.</h2>
                      <p>
                        A local tip, a small discovery, a simple wave.
                        <br />
                        Posts come from the author’s reported location.
                      </p>
                      <div className="suggestions">
                        {[
                          "Hello from here 👋",
                          "Any favorite spots around here?",
                        ].map((text) => (
                          <button key={text} onClick={() => setDraft(text)}>
                            {text}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    sorted.map((m) => (
                      <article
                        className={`message ${m.authorId === user?.id ? "own" : ""}`}
                        key={m.postId}
                      >
                        <span className="avatar">
                          {m.displayName.slice(0, 1).toUpperCase()}
                        </span>
                        <div className="message-body">
                          <div className="message-meta">
                            <strong>{m.displayName}</strong>
                            {m.authorId === user?.id && <small>you</small>}
                            <time
                              dateTime={m.createdAt}
                              title={new Date(m.createdAt).toLocaleString()}
                            >
                              {new Date(m.createdAt).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </time>
                            {m.originGeohash !== room && (
                              <button onClick={() => go(m.originGeohash)}>
                                #{m.originGeohash} ↗
                              </button>
                            )}
                          </div>
                          <p>{m.content}</p>
                          {
                            <div className="message-actions">
                              <button onClick={() => report(m)}>Report</button>
                              {(m.authorId === user?.id || user?.moderator) && (
                                <button onClick={() => remove(m)}>
                                  Delete
                                </button>
                              )}
                            </div>
                          }
                        </div>
                      </article>
                    ))
                  )}
                  <div ref={end} />
                </div>
                <form className="composer" onSubmit={send}>
                  <p className="posting-rule">
                    Read anywhere. Posting shares your reported location
                    publicly in a small geographic cell.
                  </p>
                  <label className="sr-only" htmlFor="message">
                    Post from your current location
                  </label>
                  <textarea
                    id="message"
                    disabled={sending}
                    value={draft}
                    maxLength={2000}
                    placeholder={`Post from your current location…`}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        e.currentTarget.form?.requestSubmit();
                      }
                    }}
                  />
                  <div>
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => setHelp(true)}
                    >
                      <span className="slash">/</span> commands
                    </button>
                    <small>
                      {draft.length
                        ? `${draft.length}/2000`
                        : "Location required · Read anywhere. Post from here."}
                    </small>
                    <button
                      className="send"
                      disabled={sending || !user || !draft.trim()}
                    >
                      {sending ? "Sending…" : "Send"} <span>↑</span>
                    </button>
                  </div>
                </form>
              </section>
              <aside className="details">
                <div className="territory">
                  <div className="grid-lines" />
                  <div className="map-cell">
                    <span>⌖</span>
                    <code>{room}</code>
                  </div>
                  <span className="map-caption">YOUR PATCH OF THE PLANET</span>
                </div>
                <div className="detail-copy">
                  <span className="eyebrow">A ROOM WITH A VIEW</span>
                  <h3>
                    Small places.
                    <br />
                    Bigger conversations.
                  </h3>
                  <p>
                    You’re seeing messages from this room and every smaller room
                    inside it.
                  </p>
                  {box && (
                    <div className="coordinates">
                      <span>
                        LAT {box.south.toFixed(3)} → {box.north.toFixed(3)}
                      </span>
                      <span>
                        LON {box.west.toFixed(3)} → {box.east.toFixed(3)}
                      </span>
                    </div>
                  )}
                  {room.length < 8 ? (
                    <>
                      <h4>
                        Get a little closer <span>↘</span>
                      </h4>
                      <p>Choose a smaller area within this room.</p>
                      <div className="children">
                        {[...alphabet].map((c) => (
                          <button
                            title={`Join ${room + c}`}
                            key={c}
                            onClick={() => go(room + c)}
                          >
                            {c}
                          </button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <p>You’re at the closest view.</p>
                  )}
                  <div className="room-note">
                    ↗ Read anywhere. Post from your reported location.
                  </div>
                </div>
              </aside>
            </div>
          </>
        ) : (
          <section className="welcome">
            <div className="welcome-orbit">⌖</div>
            <h2>Where shall we begin?</h2>
            <p>
              Allow location to find a nearby conversation,
              <br />
              or choose a city below.
            </p>
            <button className="primary" onClick={locate} disabled={locating}>
              {locating ? "Finding your place…" : "Find my neighborhood ↗"}
            </button>
            <div className="welcome-places">
              {places.map((p) => (
                <button key={p.room} onClick={() => go(p.room)}>
                  {p.name} ↗
                </button>
              ))}
            </div>
          </section>
        )}
        <footer>
          <span>geohash.chat</span>
          <span>A conversation for every coordinate.</span>
          <span>Stay curious. Be kind.</span>
        </footer>
      </main>
      {auth && (
        <Auth
          onClose={() => setAuth(false)}
          onDone={() => {
            setAuth(false);
            api<Identity>("/me")
              .then(setUser)
              .catch((e) => setError(e.message));
          }}
        />
      )}
      {help && (
        <div className="overlay">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-title"
          >
            <button
              className="close"
              aria-label="Close help"
              onClick={() => setHelp(false)}
            >
              ×
            </button>
            <span className="eyebrow">A QUICK FIELD GUIDE</span>
            <h2 id="help-title">The world is your chat room.</h2>
            <p>
              Every room is a geohash: a short code for a rectangle on Earth.
              Longer codes mean smaller places. A message in a small room also
              appears in all its parent rooms.
            </p>
            <dl>
              {[
                ["/join 9q8yy", "Visit another room"],
                ["/out", "Zoom out one level"],
                ["/in b", "Zoom into child b"],
                ["/here", "Find an active room near you"],
                ["/nick Your Name", "Change your guest name"],
                ["/help", "Open this guide"],
              ].map(([cmd, desc]) => (
                <div key={cmd}>
                  <dt>
                    <code>{cmd}</code>
                  </dt>
                  <dd>{desc}</dd>
                </div>
              ))}
            </dl>
            <p className="muted">
              Location is optional for browsing and required for posting.
              Posting sends coordinates, accuracy and timestamp for server
              validation; posts store a precision-8 geohash. Coarse abuse
              observations expire after 30 minutes. Browser locations can be
              spoofed. Each room holds up to 1,024 posts; random collisions
              replace posts, with no time expiry. Guest sessions last 30 days;
              names are not unique.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
