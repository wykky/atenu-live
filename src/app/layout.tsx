import type { Metadata, Viewport } from "next";
import { Galindo, Coiny, Noto_Sans_Ethiopic } from "next/font/google";
import "./globals.css";
import Script from "next/script";
import SessionWrapper from "@/components/SessionWrapper";

const galindo = Galindo({
  variable: "--font-title",
  subsets: ["latin"],
  weight: "400",
});

const chango = Coiny({
  variable: "--font-subtitle",
  subsets: ["latin"],
  weight: "400",
});

const notoEthiopic = Noto_Sans_Ethiopic({
  variable: "--font-ethiopic",
  subsets: ["ethiopic"],
  weight: ["400", "700"],
});

const SITE_URL = process.env.NEXT_PUBLIC_APP_URL || "https://live.atenu.org";
const SITE_NAME = "Atenu Live";
const DEFAULT_DESCRIPTION =
  "Atenu Live — real-time multiplayer quiz games for Ethiopian high-school students. Create, host, play.";

// Atenu Foundation NGO — used in the JSON-LD `publisher` reference below.
// The @id (atenu.org/#organization) is the cross-subdomain merging key:
// donate, lab, scholarships, blog, and teachers all emit the same id so
// search engines and AI agents resolve them to one Atenu Foundation entity.
const ATENU_ORG_URL = "https://atenu.org";
const ATENU_AGENT_HUB = "https://agents.atenu.org";

/**
 * `title.template` lets per-page metadata supply just a short label like
 * `"Quiz library"` and Next renders `"Quiz library — Atenu Live"` in the
 * browser tab and on share cards. metadataBase makes relative URLs in
 * openGraph/twitter resolve absolute.
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_NAME,
    template: `%s — ${SITE_NAME}`,
  },
  description: DEFAULT_DESCRIPTION,
  applicationName: SITE_NAME,
  authors: [{ name: 'Atenu Foundation', url: ATENU_ORG_URL }],
  keywords: [
    'live quiz',
    'multiplayer quiz',
    'Kahoot alternative',
    'classroom quiz',
    'Ethiopian education',
    'ESSLCE practice',
    'Atenu',
  ],
  alternates: { canonical: '/' },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    url: SITE_URL,
    title: SITE_NAME,
    description: DEFAULT_DESCRIPTION,
    locale: "en_ET",
  },
  twitter: {
    card: "summary",
    title: SITE_NAME,
    description: DEFAULT_DESCRIPTION,
  },
  // `agent-hub` is a custom rel/meta pair the Atenu network uses to
  // advertise the central machine-readable index. Mirrors what donate,
  // lab, scholarships, blog, and teachers all emit.
  other: {
    'agent-hub': ATENU_AGENT_HUB,
  },
};

// PWA + mobile browser theme colour matches the brand yellow so the
// address bar tint and Android task-switcher card stay on-brand.
export const viewport: Viewport = {
  themeColor: '#FFC600',
};

/**
 * JSON-LD entity graph.
 *
 * `WebApplication` is the precise schema.org type for an interactive app.
 * The `publisher` reference points at the Atenu Foundation NGO via the
 * shared @id (`atenu.org/#organization`) — the SAME id used by every
 * other Atenu subdomain. Search engines and AI agents merge those
 * subdomain descriptions into a single Atenu Foundation entity that has
 * this app as one of its surfaces.
 *
 * The full NGO entity is included inline (rather than just `{ @id: ... }`)
 * because crawlers fetch live.atenu.org without necessarily having seen
 * the other subdomains yet — sending the canonical NGO description here
 * lets them resolve `@id`s on their next pass.
 */
const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebApplication',
      '@id': `${SITE_URL}/#app`,
      name: SITE_NAME,
      url: SITE_URL,
      description: DEFAULT_DESCRIPTION,
      applicationCategory: 'EducationalApplication',
      operatingSystem: 'Any (web browser)',
      inLanguage: 'en',
      audience: {
        '@type': 'EducationalAudience',
        educationalRole: 'student',
      },
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      publisher: { '@id': `${ATENU_ORG_URL}/#organization` },
    },
    {
      '@type': 'NGO',
      '@id': `${ATENU_ORG_URL}/#organization`,
      name: 'Atenu Foundation',
      legalName: 'Atenu Foundation',
      alternateName: 'Atenu',
      url: ATENU_ORG_URL,
      logo: 'https://brand.atenu.org/logo-atenu-black.svg',
      email: 'info@atenu.org',
      sameAs: [
        'https://www.facebook.com/atenuhulunem',
        'https://www.instagram.com/atenu_/',
      ],
      address: { '@type': 'PostalAddress', addressCountry: 'CA' },
      foundingLocation: { '@type': 'Place', name: 'Canada' },
      areaServed: { '@type': 'Country', name: 'Ethiopia' },
      identifier: {
        '@type': 'PropertyValue',
        propertyID: 'Government of Canada Non-profit Corporation Number',
        value: '1700418-4',
      },
    },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="alternate" type="text/plain" title="LLM-readable index" href="/llms.txt" />
        {/* Google Analytics 4 — network-wide property (G-66F8SPKEGH) */}
        <Script
          src="https://www.googletagmanager.com/gtag/js?id=G-66F8SPKEGH"
          strategy="afterInteractive"
        />
        <Script id="ga4-init" strategy="afterInteractive">
          {`window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', 'G-66F8SPKEGH');`}
        </Script>
      </head>
      <body
        className={`${galindo.variable} ${chango.variable} ${notoEthiopic.variable} antialiased`}
      >
        {/* Structured data — WebApplication + NGO publisher graph.
            Content is built from internal constants (no user input), and we
            escape < characters so a future change can't accidentally break
            out of the script tag. Standard safe pattern for inline JSON-LD. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c'),
          }}
        />
        <SessionWrapper>
          {children}
        </SessionWrapper>
      </body>
    </html>
  );
}
