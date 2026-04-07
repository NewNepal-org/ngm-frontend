import IndexViewer from './components/IndexViewer';
import './App.css';

function App() {
  return (
    <div className="app-container">
      <header className="app-header glass">
        <div className="header-content">
          <div className="logo-group">
            <h1 className="logo">Nepal Governance Modernization</h1>
            <span className="version-pill">v1.0</span>
          </div>
          <nav>
            <a href="https://jawafdehi.org" target="_blank" rel="noopener noreferrer" className="nav-link">Jawafdehi</a>
            <a href="https://nes.jawafdehi.org" target="_blank" rel="noopener noreferrer" className="nav-link">Nepal Entity Service (NES)</a>
          </nav>
        </div>
      </header>

      <main className="main-content">
        <section className="hero slide-down">
          <h2>Judicial Data Archive</h2>
          <p>Explore structured governance and judicial records from Nepal's institutional public endpoints systematically tracked by the NGM Scrapers.</p>
        </section>

        <section className="dashboard">
          <IndexViewer />
        </section>
      </main>

      <footer className="app-footer">
        <p>&copy; {new Date().getFullYear()} Jawafdehi.org. Open Data. Open Governance.</p>
      </footer>
    </div>
  );
}

export default App;
