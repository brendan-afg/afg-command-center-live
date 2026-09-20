export type ProviderConfidence = "provider_confirmed" | "afg_claim_provider_replied" | "public_candidate";
export type ProviderProfile = {
  id: string;
  company: string;
  contactName: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  products: string[];
  sectors: string[];
  geographies: string[];
  minimumUsd: number | null;
  maximumUsd: number | null;
  requirements: string[];
  evidenceSummary: string;
  evidenceDate: string;
  evidenceSource: string;
  evidenceLocator: string;
  contactEvidenceSource: string;
  contactVerifiedAt: string;
  confidence: ProviderConfidence;
};

export const PROVIDERS: ProviderProfile[] = [
  {
    id: "slr-business-credit",
    company: "SLR Business Credit / SLR Digital Finance",
    contactName: "Jeffrey Austin",
    title: "Director, Business Development",
    email: "jeffrey@slrdigitalfinance.com",
    phone: "760-908-9730",
    website: "https://slrbusinesscredit.com/",
    products: ["Asset-Secured Capital", "Working Capital Against Revenue", "Factoring"],
    sectors: ["Service providers", "Manufacturing", "Wholesale distribution", "Digital media", "Ad tech"],
    geographies: ["United States"],
    minimumUsd: 1_000_000,
    maximumUsd: 250_000_000,
    requirements: ["Commercial accounts receivable", "US operating business", "Asset-based or factoring need"],
    evidenceSummary: "Provider correspondence states first-lien fully secured asset-based lending and factoring from US$1M to US$250M. Provider capability sheet adds receivables, inventory, machinery/equipment, and digital-media working capital.",
    evidenceDate: "2026-09-11",
    evidenceSource: "Gmail thread: Reply from SLR Business Credit; attached provider capability sheet",
    evidenceLocator: "gmail:thread:1a091ef81d754a24",
    contactEvidenceSource: "Provider email and attached capability sheet in Gmail thread 1a091ef81d754a24",
    contactVerifiedAt: "2026-09-19",
    confidence: "provider_confirmed",
  },
  {
    id: "eldridge-capital-management",
    company: "Eldridge Capital Management",
    contactName: "Ryan Bohlert",
    title: null,
    email: "ryan.bohlert@eldridge.com",
    phone: null,
    website: "https://www.eldridge.com/",
    products: ["Asset-Secured Capital", "Asset Transformation", "Equipment Finance", "Sale-Leaseback"],
    sectors: ["Revenue-producing essential-use assets", "Equipment", "Infrastructure-like operating assets"],
    geographies: ["North America evidence; confirm transaction jurisdiction directly"],
    minimumUsd: 20_000_000,
    maximumUsd: 550_000_000,
    requirements: ["Revenue-producing essential-use assets", "Verifiable ownership and value", "Transaction within stated check-size range"],
    evidenceSummary: "Provider email states US$20M-US$550M balance-sheet check size, asset-backed term loans and leases for revenue-producing essential-use assets, 75%-100% advance rates, and 36-144 month terms.",
    evidenceDate: "2026-09-14",
    evidenceSource: "Gmail thread: The last 40 of a 45, on essential-use assets",
    evidenceLocator: "gmail:thread:1a06cee6d330c8fc",
    contactEvidenceSource: "Provider email in Gmail thread 1a06cee6d330c8fc",
    contactVerifiedAt: "2026-09-19",
    confidence: "provider_confirmed",
  },
  {
    id: "pensam-capital",
    company: "Pensam Capital",
    contactName: "Ray Cleeman",
    title: "Partner, Head of Capital Markets & Lending",
    email: "rcleeman@pensamcapital.com",
    phone: "786-879-8829 / 917-892-1157",
    website: "https://pensamcapital.com/",
    products: ["Preferred Equity", "Mezzanine Capital", "Bridge Lending"],
    sectors: ["Multifamily real estate"],
    geographies: ["United States"],
    minimumUsd: null,
    maximumUsd: null,
    requirements: ["Multifamily transaction", "Senior lender identified where applicable", "Current appraisal", "Clean cap table", "Verified sponsor contribution"],
    evidenceSummary: "Provider email confirms higher-leverage lending solutions on multifamily. AFG correspondence identifies preferred equity, mezzanine, and bridge for US multifamily, and the provider agreed to review deals and scheduled a meeting.",
    evidenceDate: "2026-09-18",
    evidenceSource: "Gmail thread: Multifamily files short the middle, not the senior",
    evidenceLocator: "gmail:thread:1a0b67771f05aa71",
    contactEvidenceSource: "Provider reply and signature in Gmail thread 1a0b67771f05aa71",
    contactVerifiedAt: "2026-09-19",
    confidence: "provider_confirmed",
  },
  {
    id: "kennedy-funding",
    company: "Kennedy Funding",
    contactName: "Chase Wolfer",
    title: "Loan Officer",
    email: "chasewolfer@kennedyfunding.com",
    phone: "201-342-8500",
    website: "https://www.kennedyfunding.com/",
    products: ["Commercial Real Estate Lending", "Senior Secured Real Estate Bridge"],
    sectors: ["Commercial real estate", "Land and development with real-estate collateral"],
    geographies: ["Confirm jurisdiction and collateral directly"],
    minimumUsd: null,
    maximumUsd: null,
    requirements: ["Commercial real-estate collateral", "Completed lender application", "Transaction narrative", "Current collateral and ownership evidence"],
    evidenceSummary: "Provider correspondence reviewed a US$45M senior-secured California real-estate request and offered a letter of interest after a call. Its own email disclaimer states commercial-real-estate lending using its and participants' funds.",
    evidenceDate: "2026-09-10",
    evidenceSource: "Gmail thread: DHS 2026 LLC - $45MM Financing Request",
    evidenceLocator: "gmail:thread:1a08bc4430753bd7",
    contactEvidenceSource: "Provider reply and signature in Gmail thread 1a08bc4430753bd7",
    contactVerifiedAt: "2026-09-19",
    confidence: "provider_confirmed",
  },
  {
    id: "sallyport-commercial-finance",
    company: "Sallyport Commercial Finance",
    contactName: "Jarret Ortmann",
    title: "Business Development Executive",
    email: "jortmann@sallyportcf.com",
    phone: "832-939-9452",
    website: "https://www.sallyportcf.com/",
    products: ["Receivables Finance", "Inventory Finance", "Purchase Order Financing"],
    sectors: ["Operators with signed orders", "Revenue businesses"],
    geographies: ["United States", "Canada"],
    minimumUsd: null,
    maximumUsd: null,
    requirements: ["Confirm exact program parameters with Jarret before submitting a client file"],
    evidenceSummary: "AFG's email described receivables, inventory, and purchase-order financing in the US and Canada. Jarret replied that there may be alignment and agreed to schedule a capability call; the provider did not yet confirm detailed parameters in the connected correspondence.",
    evidenceDate: "2026-09-14",
    evidenceSource: "Gmail thread: operators with a signed order and no working capital",
    evidenceLocator: "gmail:thread:1a0a0d35b9ab08a1",
    contactEvidenceSource: "Provider reply and signature in Gmail thread 1a0a0d35b9ab08a1",
    contactVerifiedAt: "2026-09-19",
    confidence: "afg_claim_provider_replied",
  },
  {
    id: "white-oak-commercial-finance",
    company: "White Oak Commercial Finance",
    contactName: "Thomas Otte",
    title: "Chairman & Partner",
    email: "totte@whiteoakabl.com",
    phone: null,
    website: "https://whiteoaksf.com/credit-solutions/asset-based-lending/",
    products: ["Asset-Secured Capital", "Working Capital Against Revenue", "Inventory Finance", "Supply Chain Finance"],
    sectors: ["Companies with receivables", "Inventory", "Fixed assets", "Machinery and equipment", "Real estate collateral"],
    geographies: ["North America", "Europe", "Australia"],
    minimumUsd: 2_500_000,
    maximumUsd: 250_000_000,
    requirements: ["Strong performing receivables, inventory, or fixed assets", "Verifiable collateral", "Transaction within stated range"],
    evidenceSummary: "White Oak's official ABL page states up to US$250M for performing receivables, inventory, fixed assets, real estate, machinery, and equipment across North America, Europe, and Australia.",
    evidenceDate: "2026-09-19",
    evidenceSource: "White Oak official Asset-Based Lending page",
    evidenceLocator: "https://whiteoaksf.com/credit-solutions/asset-based-lending/",
    contactEvidenceSource: "White Oak official public ABL page and published business contact",
    contactVerifiedAt: "2026-09-19",
    confidence: "public_candidate",
  },
  {
    id: "ecapital-supply-chain-finance",
    company: "eCapital",
    contactName: "Jeff Butts",
    title: "SVP, Supply Chain Finance",
    email: null,
    phone: "603-860-3516",
    website: "https://ecapital.com/person/jeff-butts/",
    products: ["Purchase Order Financing", "Working Capital Against Revenue", "Supply Chain Finance", "Receivables Finance"],
    sectors: ["Manufacturing", "Wholesale", "Distribution", "Consumer goods", "Healthcare", "Transportation"],
    geographies: ["North America"],
    minimumUsd: 5_000_000,
    maximumUsd: 250_000_000,
    requirements: ["For PO finance: credible customer order and supplier details", "For receivables: verifiable commercial receivables", "Confirm the exact program and transaction size before submitting"],
    evidenceSummary: "eCapital's official pages state supply-chain, A/R, and purchase-order financing capabilities, facilities from US$5M to US$250M, and list Jeff Butts as SVP, Supply Chain Finance with North American coverage.",
    evidenceDate: "2026-09-19",
    evidenceSource: "eCapital official PO financing, contact, and Jeff Butts profile pages",
    evidenceLocator: "https://ecapital.com/person/jeff-butts/",
    contactEvidenceSource: "eCapital official Jeff Butts profile",
    contactVerifiedAt: "2026-09-19",
    confidence: "public_candidate",
  },
];

export function publicProvider(profile: ProviderProfile) {
  return { ...profile, website: profile.website, confidenceLabel: profile.confidence === "provider_confirmed" ? "Provider-confirmed" : profile.confidence === "public_candidate" ? "New public candidate—verify first" : "Confirm before use" };
}
