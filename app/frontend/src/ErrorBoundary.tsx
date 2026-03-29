import { Component, type ErrorInfo, type ReactNode } from "react";

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  errorMessage: string | null;
  errorStack: string | null;
};

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    errorMessage: null,
    errorStack: null
  };

  private handleWindowError = (event: ErrorEvent) => {
    this.setState({
      errorMessage: event.error instanceof Error ? event.error.message : event.message || "Unexpected window error.",
      errorStack: event.error instanceof Error ? event.error.stack ?? null : null
    });
  };

  private handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    if (reason instanceof Error) {
      this.setState({
        errorMessage: reason.message,
        errorStack: reason.stack ?? null
      });
      return;
    }

    this.setState({
      errorMessage: typeof reason === "string" ? reason : "Unhandled promise rejection.",
      errorStack: null
    });
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      errorMessage: error.message,
      errorStack: error.stack ?? null
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("PitchView UI crashed", error, info);
    this.setState((current) => ({
      errorMessage: current.errorMessage ?? error.message,
      errorStack: current.errorStack ?? info.componentStack ?? null
    }));
  }

  componentDidMount() {
    window.addEventListener("error", this.handleWindowError);
    window.addEventListener("unhandledrejection", this.handleUnhandledRejection);
  }

  componentWillUnmount() {
    window.removeEventListener("error", this.handleWindowError);
    window.removeEventListener("unhandledrejection", this.handleUnhandledRejection);
  }

  render() {
    if (!this.state.errorMessage) {
      return this.props.children;
    }

    return (
      <main className="app-shell crash-shell">
        <section className="crash-panel">
          <p className="eyebrow">PitchView</p>
          <h1>Desktop window crashed</h1>
          <p className="status-copy">
            The app hit an unhandled UI error. Preprocessing logs are now written on the desktop side, so rerunning the import
            should leave a trace even if the render path fails.
          </p>
          <div className="crash-detail">
            <strong>Message</strong>
            <code>{this.state.errorMessage}</code>
          </div>
          {this.state.errorStack ? (
            <div className="crash-detail">
              <strong>Stack</strong>
              <pre>{this.state.errorStack}</pre>
            </div>
          ) : null}
          <button type="button" onClick={() => window.location.reload()}>
            Reload PitchView
          </button>
        </section>
      </main>
    );
  }
}