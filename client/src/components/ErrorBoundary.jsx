import React from 'react';

// Without a boundary, any exception during render unmounts the whole tree and
// leaves a blank screen until someone reloads — not something a driver should
// have to do. This catches the crash, shows it briefly, and remounts the app
// on its own. Repeated crashes stop auto-recovering so a deterministic bug
// can't spin in a loop; the driver gets a reload button instead.

const RECOVER_AFTER_MS = 4000;
const CRASH_WINDOW_MS = 60000;
const MAX_CRASHES_IN_WINDOW = 3;

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, generation: 0, crashes: [] };
    this.timer = 0;
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[teslyr] render crash', error, info && info.componentStack);
    const now = Date.now();
    const crashes = [...this.state.crashes, now].filter((t) => now - t < CRASH_WINDOW_MS);
    this.setState({ crashes });

    clearTimeout(this.timer);
    if (crashes.length < MAX_CRASHES_IN_WINDOW) {
      this.timer = setTimeout(this.recover, RECOVER_AFTER_MS);
    }
  }

  componentWillUnmount() {
    clearTimeout(this.timer);
  }

  recover = () => {
    // A new key remounts the subtree from scratch: fresh state, fresh effects.
    this.setState((s) => ({ error: null, generation: s.generation + 1 }));
  };

  render() {
    const { error, generation, crashes } = this.state;
    if (!error) {
      return <React.Fragment key={generation}>{this.props.children}</React.Fragment>;
    }

    const stuck = crashes.length >= MAX_CRASHES_IN_WINDOW;
    return (
      <div className="flex h-full w-full items-center justify-center bg-teslyr-void px-8 text-center text-white">
        <div>
          <p className="font-display text-3xl font-extrabold text-teslyr-crimson">Teslyr</p>
          <p className="mt-4 text-lg text-teslyr-soft">
            {stuck ? 'Something keeps going wrong.' : 'Something went wrong — recovering…'}
          </p>
          <p className="mt-2 text-sm text-teslyr-mute">{String(error.message || error)}</p>
          {stuck && (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-6 h-14 rounded-full bg-white/10 px-8 text-lg font-semibold active:bg-white/25"
            >
              Reload
            </button>
          )}
        </div>
      </div>
    );
  }
}
