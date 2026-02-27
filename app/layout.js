import "./globals.css";
import FooterNav from "./components/FooterNav";
import ForegroundPushIsland from "./components/ForegroundPushIsland";
import ConsoleBridge from "./components/ConsoleBridge";
import LiveLocationTicker from "./components/LiveLocationTicker";

export const metadata = {
  title: "SchoolWays",
  description: "Seguimiento de rutas escolares en tiempo real",
  applicationName: "SchoolWays",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "SchoolWays",
  },
  icons: {
    icon: "/logo.png",
    apple: "/logo.png",
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#ffffff",
};

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body>
        {children}
        <ConsoleBridge />
        <LiveLocationTicker />
        <ForegroundPushIsland />
        <FooterNav />
      </body>
    </html>
  );
}
