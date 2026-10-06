import { Link, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { ConsentDialog } from "./components/Consent";
import { Sigil, short } from "./components/Sigil";
import { usePortalCtx } from "./PortalContext";
import { Home } from "./pages/Home";
import { SignOn } from "./pages/SignOn";
import { Games } from "./pages/Games";
import { Gallery } from "./pages/Gallery";
import { Play } from "./pages/Play";
import { Launch } from "./pages/Launch";
import { InstancePage } from "./pages/Instance";
import { GameFrame } from "./pages/GameFrame";
import { Redeem } from "./pages/Redeem";
import { WalletPage } from "./pages/Wallet";
import { ContactsPage } from "./pages/Contacts";
import { Sponsors } from "./pages/Sponsors";

function Header() {
  const { portal, refresh } = usePortalCtx();
  const nav = useNavigate();
  const signedOn = portal?.signedOn;
  return (
    <header className="top">
      <Link to="/" className="brand">
        <img src="/logo.svg" alt="F1R3FLY.io" height={28} />
        <span>Games</span>
      </Link>
      <nav>
        <NavLink to="/" end>Feed</NavLink>
        <NavLink to="/games">Games</NavLink>
        <NavLink to="/sponsors">Sponsors</NavLink>
        {signedOn && <NavLink to="/contacts">Contacts</NavLink>}
      </nav>
      <div className="who">
        {signedOn ? (
          <>
            <NavLink to="/wallet" className="wallet-chip" title={portal!.wallet.address}>
              <Sigil address={portal!.wallet.address} size={22} /> {short(portal!.wallet.address)}
            </NavLink>
            <button
              className="secondary small"
              onClick={() => {
                portal!.wallet.lock();
                refresh();
                nav("/");
              }}
            >
              Lock
            </button>
          </>
        ) : (
          <Link className="button" to="/signon">
            Sign on
          </Link>
        )}
      </div>
    </header>
  );
}

export function App() {
  const { portal, error } = usePortalCtx();
  if (error) return <main className="center"><p className="error">Cannot reach the portal service: {error}</p></main>;
  if (!portal) return <main className="center"><p className="muted">Starting…</p></main>;
  return (
    <>
      <Header />
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/signon" element={<SignOn />} />
          <Route path="/games" element={<Games />} />
          <Route path="/games/:id/gallery" element={<Gallery />} />
          <Route path="/games/:id/launch" element={<Launch />} />
          <Route path="/plays/:id" element={<Play />} />
          <Route path="/instances/:id" element={<InstancePage />} />
          <Route path="/instances/:id/play" element={<GameFrame />} />
          <Route path="/i/:id" element={<Redeem />} />
          <Route path="/wallet" element={<WalletPage />} />
          <Route path="/contacts" element={<ContactsPage />} />
          <Route path="/sponsors" element={<Sponsors />} />
        </Routes>
      </main>
      <ConsentDialog />
    </>
  );
}
