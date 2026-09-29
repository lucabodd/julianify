import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Messaggio breve mostrato al posto del contenuto che ha generato l'errore. */
  label?: string;
}

/** Isola gli errori di rendering: un pannello che si rompe non svuota l'intera pagina. */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(error, info.componentStack);
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="error-box" role="alert">
          <strong>{this.props.label ?? 'Si è verificato un errore'}</strong>
          <span className="muted small">{this.state.error.message}</span>
          <button onClick={() => this.setState({ error: null })}>Riprova</button>
        </div>
      );
    }
    return this.props.children;
  }
}
