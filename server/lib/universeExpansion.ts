/**
 * universeExpansion.ts
 *
 * Expands the universe with comprehensive global coverage.
 * ADDITIVE ONLY — uses ON CONFLICT DO NOTHING semantics.
 * Never removes, deactivates, or modifies any existing ticker.
 *
 * Called via POST /api/universe/expand
 */

import { rawSqlite as sqlite } from "../storage";

// ─── Helper to derive region/country/exchange from ticker suffix ──────────────
function metaFromTicker(ticker: string): {
  exchange: string; country: string; region: string; currency: string;
  assetType: string;
} {
  if (ticker.endsWith(".DE")) return { exchange: "XETRA",    country: "Germany",        region: "Europe",        currency: "EUR", assetType: "stock" };
  if (ticker.endsWith(".PA")) return { exchange: "EPA",       country: "France",         region: "Europe",        currency: "EUR", assetType: "stock" };
  if (ticker.endsWith(".L"))  return { exchange: "LSE",       country: "United Kingdom", region: "Europe",        currency: "GBP", assetType: "stock" };
  if (ticker.endsWith(".MI")) return { exchange: "BIT",       country: "Italy",          region: "Europe",        currency: "EUR", assetType: "stock" };
  if (ticker.endsWith(".AS")) return { exchange: "AEX",       country: "Netherlands",    region: "Europe",        currency: "EUR", assetType: "stock" };
  if (ticker.endsWith(".SW")) return { exchange: "SIX",       country: "Switzerland",    region: "Europe",        currency: "CHF", assetType: "stock" };
  if (ticker.endsWith(".MC")) return { exchange: "BME",       country: "Spain",          region: "Europe",        currency: "EUR", assetType: "stock" };
  if (ticker.endsWith(".ST")) return { exchange: "NASDAQ_ST", country: "Sweden",         region: "Europe",        currency: "SEK", assetType: "stock" };
  if (ticker.endsWith(".OL")) return { exchange: "OSE",       country: "Norway",         region: "Europe",        currency: "NOK", assetType: "stock" };
  if (ticker.endsWith(".CO")) return { exchange: "CSE",       country: "Denmark",        region: "Europe",        currency: "DKK", assetType: "stock" };
  if (ticker.endsWith(".HE")) return { exchange: "HSE",       country: "Finland",        region: "Europe",        currency: "EUR", assetType: "stock" };
  if (ticker.endsWith(".VI")) return { exchange: "WBAG",      country: "Austria",        region: "Europe",        currency: "EUR", assetType: "stock" };
  if (ticker.endsWith(".BR")) return { exchange: "EBR",       country: "Belgium",        region: "Europe",        currency: "EUR", assetType: "stock" };
  if (ticker.endsWith(".LS")) return { exchange: "ELI",       country: "Portugal",       region: "Europe",        currency: "EUR", assetType: "stock" };
  if (ticker.endsWith(".WA")) return { exchange: "WSE",       country: "Poland",         region: "Europe",        currency: "PLN", assetType: "stock" };
  if (ticker.endsWith(".BD")) return { exchange: "BSE",       country: "Hungary",        region: "Europe",        currency: "HUF", assetType: "stock" };
  if (ticker.endsWith(".PR")) return { exchange: "PSE",       country: "Czech Republic", region: "Europe",        currency: "CZK", assetType: "stock" };
  if (ticker.endsWith(".RO")) return { exchange: "BVB",       country: "Romania",        region: "Europe",        currency: "RON", assetType: "stock" };
  if (ticker.endsWith(".IS")) return { exchange: "BIST",      country: "Turkey",         region: "Europe",        currency: "TRY", assetType: "stock" };
  if (ticker.endsWith(".ME")) return { exchange: "MOEX",      country: "Russia",         region: "Europe",        currency: "RUB", assetType: "stock" };
  if (ticker.endsWith(".T"))  return { exchange: "TSE",       country: "Japan",          region: "Asia-Pacific",  currency: "JPY", assetType: "stock" };
  if (ticker.endsWith(".KS")) return { exchange: "KSE",       country: "South Korea",    region: "Asia-Pacific",  currency: "KRW", assetType: "stock" };
  if (ticker.endsWith(".KQ")) return { exchange: "KOSDAQ",    country: "South Korea",    region: "Asia-Pacific",  currency: "KRW", assetType: "stock" };
  if (ticker.endsWith(".TW")) return { exchange: "TWSE",      country: "Taiwan",         region: "Asia-Pacific",  currency: "TWD", assetType: "stock" };
  if (ticker.endsWith(".AX")) return { exchange: "ASX",       country: "Australia",      region: "Asia-Pacific",  currency: "AUD", assetType: "stock" };
  if (ticker.endsWith(".HK")) return { exchange: "HKEX",      country: "Hong Kong",      region: "Asia-Pacific",  currency: "HKD", assetType: "stock" };
  if (ticker.endsWith(".BO")) return { exchange: "BSE",       country: "India",          region: "Asia-Pacific",  currency: "INR", assetType: "stock" };
  if (ticker.endsWith(".NS")) return { exchange: "NSE",       country: "India",          region: "Asia-Pacific",  currency: "INR", assetType: "stock" };
  if (ticker.endsWith(".BK")) return { exchange: "SET",       country: "Thailand",       region: "Asia-Pacific",  currency: "THB", assetType: "stock" };
  if (ticker.endsWith(".SI")) return { exchange: "SGX",       country: "Singapore",      region: "Asia-Pacific",  currency: "SGD", assetType: "stock" };
  if (ticker.endsWith(".KL")) return { exchange: "KLSE",      country: "Malaysia",       region: "Asia-Pacific",  currency: "MYR", assetType: "stock" };
  if (ticker.endsWith(".JK")) return { exchange: "IDX",       country: "Indonesia",      region: "Asia-Pacific",  currency: "IDR", assetType: "stock" };
  if (ticker.endsWith(".PS")) return { exchange: "PSE",       country: "Philippines",    region: "Asia-Pacific",  currency: "PHP", assetType: "stock" };
  if (ticker.endsWith(".SA")) return { exchange: "BOVESPA",   country: "Brazil",         region: "Americas",      currency: "BRL", assetType: "stock" };
  if (ticker.endsWith(".MX")) return { exchange: "BMV",       country: "Mexico",         region: "Americas",      currency: "MXN", assetType: "stock" };
  if (ticker.endsWith(".BA")) return { exchange: "BYMA",      country: "Argentina",      region: "Americas",      currency: "ARS", assetType: "stock" };
  if (ticker.endsWith(".TO")) return { exchange: "TSX",       country: "Canada",         region: "Americas",      currency: "CAD", assetType: "stock" };
  if (ticker.endsWith(".TA")) return { exchange: "TASE",      country: "Israel",         region: "Middle East",   currency: "ILS", assetType: "stock" };
  if (ticker.endsWith(".SR")) return { exchange: "TADAWUL",   country: "Saudi Arabia",   region: "Middle East",   currency: "SAR", assetType: "stock" };
  if (ticker.endsWith(".CA")) return { exchange: "EGX",       country: "Egypt",          region: "Africa",        currency: "EGP", assetType: "stock" };
  // US — no suffix
  return { exchange: "US", country: "United States", region: "Americas", currency: "USD", assetType: "stock" };
}

// ─── Complete hardcoded ticker lists ─────────────────────────────────────────

// S&P 500
const SP500: string[] = [
  "MMM","AOS","ABT","ABBV","ACN","ADBE","AMD","AES","AFL","A","APD","ABNB","AKAM","ALB","ARE","ALGN","ALLE","LNT","ALL","GOOGL","GOOG","MO","AMZN","AMCR","AEE","AAL","AEP","AXP","AIG","AMT","AWK","AMP","AME","AMGN","APH","ADI","ANSS","AON","APA","AAPL","AMAT","APTV","ACGL","ADM","ANET","AJG","AIZ","T","ATO","ADSK","ADP","AZO","AVB","AVY","AXON","BKR","BALL","BAC","BBWI","BAX","BDX","WRB","BRK.B","BBY","BIO","TECH","BIIB","BLK","BX","BA","BCF","BAH","BWA","BSX","BMY","AVGO","BR","BRO","BF.B","BLDR","BG","CDNS","CZR","CPT","CPB","COF","CAH","KMX","CCL","CARR","CTLT","CAT","CBOE","CBRE","CDW","CE","COR","CNC","CNP","CF","CHRW","CRL","SCHW","CHTR","CVX","CMG","CB","CHD","CI","CINF","CTAS","CSCO","C","CFG","CLX","CME","CMS","KO","CTSH","CL","CMCSA","CMA","CAG","COP","ED","STZ","CEG","COO","CPRT","GLW","CTVA","CSGP","COST","CTRA","CCI","CSX","CMI","CVS","DHI","DHR","DRI","DVA","DAY","DE","DELL","DAL","DVN","DXCM","FANG","DLR","DFS","DG","DLTR","D","DPZ","DOV","DOW","LLY","EMN","ETN","EBAY","ECL","EIX","EW","EA","ELV","EMR","ENPH","ETR","EOG","EPAM","EQT","EFX","EQIX","EQR","ESS","EL","ETSY","EG","EVRG","ES","EXC","EXPE","EXPD","EXR","XOM","FFIV","FDS","FICO","FAST","FRT","FDX","FIS","FITB","FSLR","FE","FI","F","FTNT","FTV","FOXA","FOX","BEN","FCX","GRMN","IT","GE","GEHC","GEN","GNRC","GD","GIS","GM","GPC","GILD","GPN","GL","GDDY","GS","HAL","HIG","HAS","HCA","DOC","HSIC","HSY","HES","HPE","HLT","HOLX","HD","HON","HRL","HST","HWM","HPQ","HUBB","HUM","HBAN","HII","IBM","IEX","IDXX","ITW","ILMN","INCY","IR","PODD","INTC","ICE","IFF","IP","IPG","INTU","ISRG","IVZ","INVH","IQV","IRM","JBHT","JBL","JKHY","J","JNJ","JCI","JPM","JNPR","K","KVUE","KDP","KEY","KEYS","KMB","KIM","KMI","KLAC","KHC","KR","LHX","LH","LRCX","LW","LVS","LDOS","LEN","LNC","LIN","LYV","LKQ","LMT","L","LOW","LULU","LYB","MTB","MRO","MPC","MKTX","MAR","MMC","MLM","MAS","MA","MTCH","MKC","MCD","MCK","MDT","MRK","META","MET","MTD","MGM","MCHP","MU","MSFT","MAA","MRNA","MHK","MOH","TAP","MDLZ","MPWR","MNST","MCO","MS","MSI","MSCI","NDAQ","NTAP","NFLX","NEM","NWSA","NWS","NEE","NKE","NI","NDSN","NSC","NTRS","NOC","NCLH","NRG","NUE","NVDA","NVR","NXPI","ORLY","OXY","ODFL","OMC","ON","OKE","ORCL","OTIS","PCAR","PKG","PLTR","PANW","PARA","PH","PAYX","PAYC","PYPL","PNR","PEP","PFE","PCG","PM","PSX","PNW","PXD","PNC","POOL","PPG","PPL","PFG","PG","PGR","PLD","PRU","PEG","PTVE","PTC","PSA","PHM","QRVO","PWR","QCOM","DGX","RL","RJF","RTX","O","REG","REGN","RF","RSG","RMD","RVTY","ROK","ROL","ROP","ROST","RCL","SPGI","CRM","SBAC","SLB","STX","SRE","NOW","SHW","SPG","SWKS","SJM","SW","SNA","SOLV","SO","LUV","SWK","SBUX","STT","STLD","STE","SYK","SMCI","SYF","SNPS","SYY","TMUS","TROW","TTWO","TPR","TRGP","TGT","TEL","TDY","TFX","TER","TSLA","TXN","TXT","TMO","TJX","TSCO","TT","TDG","TRV","TRMB","TFC","TYL","TSN","USB","UBER","UDR","UHS","UNP","UAL","UPS","URI","UNH","UHS","VLO","VTR","VRSN","VRSK","VZ","VRTX","VLTO","VMC","WRK","WBA","WAB","WMT","DIS","WBD","WM","WAT","WEC","WFC","WELL","WST","WDC","WHR","WMB","WTW","GWW","WYNN","XEL","XYL","YUM","ZBRA","ZBH","ZTS",
];

// NASDAQ-100
const NASDAQ100: string[] = [
  "ADSK","AEP","ALGN","ALXN","AMD","AMGN","AMZN","ANSS","ASML","ATVI","AVGO","BIDU","BIIB","BKNG","CDNS","CDW","CEG","CHKP","CHTR","CMCSA","COST","CPRT","CRWD","CSCO","CSX","CTAS","CTSH","DDOG","DLTR","DXCM","EA","EBAY","EXC","FANG","FAST","FISV","FTNT","GILD","GOOGL","HON","IDXX","ILMN","INTC","INTU","ISRG","JD","KDP","KHC","KLAC","LCID","LRCX","LULU","MAR","MCHP","MDLZ","META","MNST","MRNA","MRVL","MSFT","MU","NFLX","NXPI","ODFL","ON","ORLY","PANW","PAYX","PCAR","PDD","PEP","PYPL","QCOM","REGN","RIVN","ROST","SBUX","SGEN","SIRI","SNPS","SPLK","TEAM","TMUS","TSLA","TXN","VRTX","WBA","WDAY","XEL","ZM","ZS","OKTA","ABNB","AZN","GEHC","GFS","APP","MSTR",
];

// Russell 1000 additions (large/mid cap US not typically in S&P500/NDX100)
const RUSSELL1000_EXTRA: string[] = [
  "ACGL","ACI","ACLX","ADEA","AGL","AGYS","AIRC","AIT","AKAM","AL","ALKS","ALNY","ALV","AMCX","AMG","AMKR","AMNB","AMPH","AMRK","AMSF","AMTB","AMWD","AN","ANDE","ANF","ANIK","ANV","AORT","APAM","APC","APOG","APPA","APRE","ARI","ARKO","AROC","ARWR","ASB","ASH","ASGN","ASIX","ASLYX","ASTE","AT","ATEC","ATI","ATMU","ATUS","ATVI","AU","AVT","AWI","AX","AXS","AXTA","AZPN","B","BANC","BANF","BANR","BCC","BCPC","BDN","BEN","BERY","BFIN","BGC","BGCP","BHE","BIDU","BJRI","BKI","BKNG","BLDP","BMRN","BOOT","BOYD","BPOP","BRX","BSIG","BSY","BTG","BVN","BWXT","BYD","CAC","CALM","CAMT","CAR","CARG","CARS","CAS","CASH","CASY","CATX","CBRE","CBRL","CBTX","CC","CDAY","CDRE","CEF","CEIX","CELH","CENTA","CHCO","CHEF","CHGG","CHH","CIR","CIX","CLNE","CLVT","CMC","CMCO","CMLS","CNDT","CNOB","CNXC","COHU","COKE","COR","CORR","COUR","CPK","CPRX","CPSS","CR","CRBG","CRGY","CRI","CROX","CRSP","CRUS","CRY","CSL","CSWI","CTLT","CTT","CUZ","CVBF","CW","CWT","CXM","CXT","CYBE","CYNA","DAR","DBX","DECK","DEI","DEN","DINO","DKS","DLB","DLPH","DNLI","DNN","DOCN","DOCS","DOO","DOOR","DORM","DOUG","DRS","DS","DSGX","DSP","DT","DTM","DV","DVAX","EAT","EBC","EBIX","EBTC","EFC","EGP","EHAB","EHC","ENOV","ENSG","ENS","ENTG","ENVX","EPAM","EPRT","EQH","ESAB","ESGR","EVC","EVBG","EVGO","EVRI","EVO","EXAS","EXEL","EYE","EZPW","FANG","FAT","FBC","FBHS","FBP","FCF","FCNCA","FDUS","FFIN","FGBI","FHB","FHN","FIVN","FIZZ","FLNC","FLYW","FMC","FMNB","FN","FNB","FND","FOA","FOLD","FORM","FOXF","FRME","FRSH","FSK","FSS","FTDR","FULT","G","GATX","GB","GBCI","GBTG","GCI","GCO","GCUS","GDEN","GEOS","GFF","GFI","GHC","GHM","GIB","GII","GKOS","GLP","GLPI","GMS","GNRC","GOEV","GOOD","GPI","GPMT","GPX","GRFS","GRMN","GSHD","GTLS","GVA","H","HALO","HBI","HCAT","HCOM","HCSG","HDSN","HI","HIBB","HIO","HLF","HLMN","HLNE","HLX","HMST","HNI","HOFT","HOPE","HRMY","HRB","HROW","HSC","HTBK","HTGC","HTZ","HURC","HWKN","HXL","HYLN","HZO","IBP","ICHR","ICU","IIIV","IMXI","INDB","INFN","INGR","INIT","IPAR","IPGP","IRDM","IRT","ITIC","ITT","IIPR","JHG","JLL","JOE","JOBY","JPM","JRVR","JYNT","KAI","KAMN","KAR","KBAL","KBH","KBR","KFRC","KFY","KLIC","KN","KNF","KNX","KRC","KRG","KRYS","KTOS","KW","KYMR","LANC","LCI","LCII","LCNB","LFC","LGIH","LGF.A","LGF.B","LGND","LHX","LKFN","LMAT","LMNR","LNDC","LNN","LPLA","LPT","LQDT","LRN","LSI","LSTR","LTHM","LWAY","LXP","LZB","MARA","MATV","MATW","MAXN","MCS","MD","MDGL","MDU","MEG","MEI","MELI","METC","MFIN","MG","MHO","MIDD","MIME","MLAB","MLI","MMSI","MNKD","MNRO","MNSO","MNST","MOG.A","MPW","MPX","MRCY","MRC","MRTN","MTG","MTSI","MTW","MTX","MUR","MYRG","NBR","NCMI","NCR","NDAQ","NEOG","NEWR","NFBK","NFG","NGVC","NHC","NHI","NIC","NJR","NNI","NOG","NRDS","NRP","NRXS","NTES","NUS","NVE","NVGS","NWBI","NWL","NX","NYT","OFG","OII","OKE","OMAB","OMCL","OMF","OPI","ORA","ORCL","ORION","OSBC","OSCR","OSI","OTEX","OVV","OXM","PACS","PAHC","PATK","PBCT","PCAR","PCTY","PDCE","PDCO","PEBO","PEN","PENN","PETS","PFH","PGNY","PHIN","PI","PINC","PIPR","PJT","PK","PKOH","PNM","PNRG","POWL","PRDO","PRGO","PRGS","PRK","PRMW","PROS","PROX","PRVB","PSN","PSTG","PTCT","PTEN","PUMP","PVBC","PVH","PYCR","QS","QTWO","QUAD","QUAL","QUBT","QURE","RCM","RCUS","RDNT","RDUS","REI","REPX","REYN","REZI","RGR","RH","RIG","RKLB","RLI","RLJ","RNST","ROCC","RPM","RPND","RRC","RRGB","RRR","RSSS","RTL","RUSHA","RWT","RXRX","RYI","SAFE","SAH","SAIC","SANM","SBGI","SBSI","SCCO","SCHE","SCI","SCON","SEIC","SF","SFBS","SFM","SGH","SIGI","SII","SIRI","SKT","SLM","SLN","SM","SMCI","SNEX","SOC","SPA","SPNT","SPSC","SPWR","SQ","SSNC","STAG","STAR","STBA","STC","STE","STEP","STRA","SUM","SUPN","SWBI","SWN","SXI","SYBT","SYKE","SYM","SYRE","TBBK","TBI","TBK","TCBK","TCF","TCNNF","TDOC","TGLS","THC","TILE","TIME","TKR","TLDH","TME","TORC","TPIC","TPVG","TREE","TREX","TRNO","TRNX","TROW","TRST","TRTN","TRU","TRUP","TTC","TTGT","TTM","TTWO","TVTX","TX","TYRA","UDR","UFCS","UFPT","UGI","UNF","UNIT","UONE","UPH","UPST","USTR","UTL","UTZ","VALE","VBTX","VCTR","VECO","VERI","VFC","VGRX","VIRT","VKTX","VLRS","VOXX","VRE","VSCO","VSTO","VVV","VYGR","WAL","WASH","WCC","WEN","WERN","WGO","WHD","WINA","WIRE","WLYB","WMS","WNEB","WOR","WOW","WPM","WRBY","WRE","WS","WSBC","WSFS","WU","WWD","XNCR","XPO","XRAY","XRX","YEXT","YORW","ZD","ZION","ZTO","ZWS",
];

// TSX 60 — Canada
const TSX60: string[] = [
  "ABX.TO","AEM.TO","AGI.TO","ALA.TO","AP-UN.TO","ATD.TO","BAM.TO","BNS.TO",
  "BMO.TO","BPY-UN.TO","CAE.TO","CCO.TO","CHP-UN.TO","CM.TO","CNQ.TO","CNR.TO",
  "CP.TO","CTC-A.TO","CVE.TO","DOL.TO","EMA.TO","ENB.TO","EQB.TO","FM.TO",
  "FTS.TO","GIB-A.TO","GWO.TO","H.TO","IMO.TO","IFC.TO","IPL.TO","K.TO",
  "KEY.TO","KXS.TO","L.TO","LB.TO","MFC.TO","MG.TO","MRU.TO","MTY.TO",
  "NA.TO","NTR.TO","OTEX.TO","POW.TO","PPL.TO","RCI-B.TO","RY.TO","SAP.TO",
  "SLF.TO","SNC.TO","SRU-UN.TO","SU.TO","T.TO","TD.TO","TIH.TO","TRP.TO",
  "WCN.TO","WN.TO","WSP.TO","X.TO",
];

// DAX 40 — Germany
const DAX40: string[] = [
  "1COV.DE","ADS.DE","AIR.DE","ALV.DE","BAS.DE","BAYN.DE","BEI.DE","BMW.DE",
  "BNR.DE","CON.DE","1COV.DE","DB1.DE","DBK.DE","DHL.DE","DTE.DE","EOAN.DE",
  "FRE.DE","HFG.DE","HNR1.DE","HEI.DE","IFX.DE","LIN.DE","MBG.DE","MRK.DE",
  "MTX.DE","MUV2.DE","P911.DE","PAH3.DE","PUM.DE","QGEN.DE","RHM.DE","RWE.DE",
  "SAP.DE","SHL.DE","SIE.DE","SRT.DE","SY1.DE","VOW3.DE","VNA.DE","ZAL.DE",
];

// MDAX top 50 — Germany mid-cap
const MDAX50: string[] = [
  "AIXA.DE","ARND.DE","BC8.DE","BNP.DE","BOSS.DE","CWC.DE","DWS.DE","ENR.DE",
  "EVD.DE","EVK.DE","FPE.DE","GBF.DE","GFT.DE","HAB.DE","HLE.DE","HOT.DE",
  "JDEP.DE","JUN3.DE","K+S.DE","KGX.DE","KSB.DE","KION.DE","LEO.DE","LHA.DE",
  "MDO.DE","NOEJ.DE","O2D.DE","PAG.DE","PBB.DE","PSM.DE","RAA.DE","RDC.DE",
  "RRTL.DE","SDAX.DE","SFQ.DE","SKB.DE","SZG.DE","SZU.DE","TAG.DE","TLX.DE",
  "TUI1.DE","UTDI.DE","VIB3.DE","WCH.DE","WUW.DE","XONA.DE","GHH.DE","ECV.DE",
  "NDX1.DE","RHK.DE",
];

// CAC 40 — France
const CAC40: string[] = [
  "AC.PA","ACA.PA","AI.PA","AIR.PA","ALO.PA","BN.PA","BNP.PA","CA.PA",
  "CAP.PA","CS.PA","DG.PA","DSY.PA","ENGI.PA","ERF.PA","EL.PA","GLE.PA",
  "HO.PA","KER.PA","LR.PA","LHN.PA","MC.PA","ML.PA","MT.PA","ORA.PA",
  "PUB.PA","RI.PA","RMS.PA","SAF.PA","SGO.PA","SAN.PA","SCR.PA","STLAM.PA",
  "STM.PA","SU.PA","TEC.PA","URW.PA","VIE.PA","VIV.PA","DEC.PA","WLN.PA",
];

// FTSE 100 — UK
const FTSE100: string[] = [
  "AAL.L","ABF.L","ADM.L","AHT.L","ANTO.L","AZN.L","AUTO.L","AV.L","BA.L",
  "BARC.L","BATS.L","BKG.L","BLND.L","BP.L","BRBY.L","BT-A.L","CCH.L","CPG.L",
  "CRH.L","DCC.L","DGE.L","DPLM.L","EDV.L","ENT.L","EXPN.L","FLTR.L","FRES.L",
  "GLEN.L","GSK.L","HLMA.L","HMSO.L","HL.L","HSBA.L","IAG.L","IHG.L","III.L",
  "IMB.L","IMI.L","INF.L","ITV.L","JD.L","KGF.L","LAND.L","LGEN.L","LLOY.L",
  "LSEG.L","MKS.L","MNDI.L","MNG.L","MRO.L","NG.L","NWG.L","OCDO.L","PHNX.L",
  "PSH.L","PSN.L","PSON.L","RB.L","RDSA.L","REL.L","RIO.L","RKT.L","RMV.L",
  "RR.L","RS1.L","SBRY.L","SCHP.L","SDR.L","SGE.L","SHEL.L","SKG.L","SMDS.L",
  "SMIN.L","SMT.L","SN.L","STAN.L","SVT.L","TSCO.L","TW.L","ULVR.L","UU.L",
  "UTG.L","VOD.L","VTY.L","WEIR.L","WPP.L","WTB.L","ABI.L","BDEV.L","CRDA.L",
  "DPH.L","JET.L","OCDO.L","PRTC.L","SMWH.L","SPDI.L","STJ.L","TUI.L","WMH.L",
];

// FTSE MIB 40 — Italy
const FTSEMIB: string[] = [
  "A2A.MI","AMP.MI","ATL.MI","BAMI.MI","BGN.MI","BMPS.MI","BPSO.MI","BPE.MI",
  "BSRP.MI","CPR.MI","DIA.MI","ENEL.MI","ENI.MI","ERST.MI","EXO.MI","FBK.MI",
  "FTSEMIB.MI","G.MI","HER.MI","INWT.MI","IP.MI","ISP.MI","JUVE.MI","LDO.MI",
  "MB.MI","MONC.MI","PIRC.MI","PRY.MI","PST.MI","REC.MI","SRG.MI","SPM.MI",
  "STM.MI","TEN.MI","TIT.MI","TRN.MI","UBI.MI","UCG.MI","UNI.MI","TIT.MI",
];

// AEX 25 — Netherlands
const AEX25: string[] = [
  "ABN.AS","ADYEN.AS","AGN.AS","AKZA.AS","ARCE.AS","ASM.AS","ASML.AS","BRNL.AS",
  "DSM.AS","EXOR.AS","GLPG.AS","HEIA.AS","INGA.AS","KPN.AS","MT.AS","NN.AS",
  "PHIA.AS","PRX.AS","RAND.AS","RDSA.AS","REN.AS","SBM.AS","UMG.AS","URW.AS","WKL.AS",
];

// SMI 20 — Switzerland
const SMI20: string[] = [
  "ABBN.SW","ADEN.SW","CSGN.SW","GALE.SW","GIVN.SW","HOLN.SW","KNIN.SW","LOGN.SW",
  "LONN.SW","NESN.SW","NOVN.SW","PGHN.SW","ROG.SW","SGSN.SW","SIKA.SW","SLHN.SW",
  "SRENH.SW","UBSG.SW","UHRN.SW","ZURN.SW",
];

// IBEX 35 — Spain
const IBEX35: string[] = [
  "ACS.MC","ACX.MC","AENA.MC","AMS.MC","ANA.MC","BBVA.MC","BKT.MC","CABK.MC",
  "CLNX.MC","COL.MC","ELE.MC","ENG.MC","FDR.MC","FER.MC","GRF.MC","IAG.MC",
  "IBE.MC","IDR.MC","ITX.MC","LOG.MC","MAP.MC","MEL.MC","MRL.MC","MTS.MC",
  "NTGY.MC","PHM.MC","RED.MC","REE.MC","REP.MC","ROVI.MC","SAB.MC","SAN.MC",
  "SCYR.MC","SOL.MC","TEF.MC",
];

// OMX Stockholm 30 — Sweden
const OMX30: string[] = [
  "ABB.ST","ALFA.ST","ALIV-SDB.ST","ASSA-B.ST","AZN.ST","ATCO-A.ST","ATCO-B.ST",
  "AXFO.ST","BOL.ST","ELUX-B.ST","ERIC-B.ST","ESSITY-B.ST","EVO.ST","GETI-B.ST",
  "HEXA-B.ST","HM-B.ST","HUSQ-B.ST","INVE-B.ST","KINV-B.ST","NDA-SE.ST","NIBE-B.ST",
  "SAND.ST","SCA-B.ST","SEB-A.ST","SKA-B.ST","SKF-B.ST","SSAB-A.ST","SWED-A.ST",
  "TEL2-B.ST","VOLV-B.ST",
];

// OBX 25 — Norway
const OBX25: string[] = [
  "AKSO.OL","AKER.OL","AKERBP.OL","AKERH.OL","BAKKA.OL","BWLPG.OL","DNB.OL",
  "EQNR.OL","MOWI.OL","NHY.OL","NONG.OL","NRC.OL","RECSI.OL","SALM.OL","SCATC.OL",
  "SRBNK.OL","STB.OL","SUBC.OL","TELENOR.OL","TGS.OL","VEI.OL","WILS.OL","YAR.OL",
  "PHLY.OL","KAHOT.OL",
];

// OMX Copenhagen 25 — Denmark
const OMXC25: string[] = [
  "AMBU-B.CO","BAVA.CO","CARL-B.CO","CHR.CO","COLO-B.CO","DEMANT.CO","DSV.CO",
  "FLS.CO","GMAB.CO","GN.CO","ISS.CO","JYSK.CO","MAERSK-A.CO","MAERSK-B.CO",
  "NETC.CO","NFLX.CO","NKT.CO","NOVO-B.CO","NZYM-B.CO","ORSTED.CO","PNDORA.CO",
  "RBREW.CO","ROCK-B.CO","SYDB.CO","TRYG.CO",
];

// OMX Helsinki 25 — Finland
const OMXH25: string[] = [
  "CGCBV.HE","EQNR.HE","FORTUM.HE","HARVIA.HE","HKSAV.HE","KEMIRA.HE","KESKO-B.HE",
  "KONE.HE","METSO.HE","NESTE.HE","NOKIA.HE","ORNBV.HE","OUT1V.HE","QTCOM.HE",
  "RANDOM.HE","SAMPO-A.HE","STERV.HE","TIETO.HE","UPM.HE","VALMT.HE","WRT1V.HE",
  "YAMAHAS.HE","YIT.HE","1531.HE","ELISA.HE",
];

// ATX 20 — Austria
const ATX20: string[] = [
  "AGB.VI","AIC.VI","ANDR.VI","BAWG.VI","BG.VI","CAI.VI","EVN.VI","EBS.VI",
  "FACC.VI","IIA.VI","ILF.VI","IMMO.VI","OMV.VI","POST.VI","RBI.VI","RHI.VI",
  "S.VI","TELE.VI","UQA.VI","VER.VI",
];

// BEL 20 — Belgium
const BEL20: string[] = [
  "ABI.BR","ACKB.BR","AGS.BR","APAM.BR","ARGX.BR","BPOST.BR","CFE.BR","COLR.BR",
  "D8.BR","ELI.BR","GBLB.BR","GLPG.BR","ING.BR","ONTEX.BR","PROX.BR","SOF.BR",
  "SOLB.BR","TNET.BR","UCB.BR","UMI.BR",
];

// PSI 20 — Portugal
const PSI20: string[] = [
  "CTT.LS","EDP.LS","EDPR.LS","GALP.LS","GREE.LS","IBS.LS","JMT.LS","MTRX.LS",
  "NVG.LS","NOS.LS","NVG.LS","RAM.LS","RDME.LS","REN.LS","SEMAPA.LS","SLBEN.LS",
  "SONAE.LS","SNC.LS","THE.LS","SONC.LS",
];

// WIG 20 — Poland
const WIG20: string[] = [
  "ALE.WA","CCC.WA","CDR.WA","CPS.WA","DNP.WA","JSW.WA","KGH.WA","KRU.WA",
  "LPP.WA","MBK.WA","OPL.WA","PCO.WA","PEO.WA","PGE.WA","PKOBP.WA","PKN.WA",
  "PZU.WA","SPL.WA","TPE.WA","TXT.WA",
];

// BUX 20 — Hungary
const BUX20: string[] = [
  "ANY.BD","AUTODANI.BD","BERU.BD","BIF.BD","DEMO.BD","ENEFI.BD","ESTMEDIA.BD",
  "FORRAS.BD","GRABOPLAST.BD","KPACK.BD","LIPO.BD","MASTERPLAST.BD","MOL.BD",
  "MTELEKOM.BD","OPIMUS.BD","OTP.BD","PANNERGY.BD","RABA.BD","RICHT.BD","WABERERS.BD",
];

// PX Index top 15 — Czech Republic
const PX15: string[] = [
  "CEZ.PR","CETV.PR","CMG.PR","COME.PR","EB.PR","ERBAG.PR","FOREG.PR","KOMB.PR",
  "MONET.PR","NWR.PR","O2CR.PR","PEGAS.PR","PHIL.PR","TBCA.PR","VGP.PR",
];

// BET 20 — Romania
const BET20: string[] = [
  "AAP.RO","ALR.RO","BRD.RO","BRK.RO","DIGI.RO","EL.RO","FP.RO","H2O.RO",
  "M.RO","ONE.RO","PREH.RO","RDBK.RO","REQT.RO","SFG.RO","SNG.RO","SNP.RO",
  "SOCP.RO","SRS.RO","TBM.RO","TGN.RO",
];

// BIST 30 — Turkey
const BIST30: string[] = [
  "AKBNK.IS","ARCLK.IS","ASELS.IS","BIMAS.IS","DOHOL.IS","EKGYO.IS","EREGL.IS",
  "FROTO.IS","GARAN.IS","GUBRF.IS","HALKB.IS","ISCTR.IS","KCHOL.IS","KOZAL.IS",
  "KRDMD.IS","MAVI.IS","PETKM.IS","PGSUS.IS","SAHOL.IS","SASA.IS","SISE.IS",
  "TAVHL.IS","TCELL.IS","THYAO.IS","TKFEN.IS","TOASO.IS","TTRAK.IS","VAKBN.IS",
  "VESTL.IS","YKBNK.IS",
];

// Nikkei 225 — Japan (selected liquid names)
const NIKKEI225: string[] = [
  "1332.T","1605.T","1803.T","1808.T","1812.T","1925.T","1928.T","2002.T",
  "2269.T","2282.T","2413.T","2432.T","2502.T","2503.T","2801.T","2802.T",
  "2871.T","2914.T","3086.T","3099.T","3382.T","3402.T","3407.T","3436.T",
  "3659.T","3861.T","3863.T","4004.T","4005.T","4021.T","4042.T","4043.T",
  "4061.T","4063.T","4151.T","4183.T","4188.T","4208.T","4307.T","4324.T",
  "4452.T","4502.T","4503.T","4506.T","4507.T","4519.T","4523.T","4543.T",
  "4568.T","4578.T","4661.T","4689.T","4704.T","4751.T","4755.T","4901.T",
  "4902.T","5019.T","5020.T","5101.T","5108.T","5201.T","5202.T","5214.T",
  "5232.T","5233.T","5301.T","5332.T","5333.T","5401.T","5406.T","5411.T",
  "5541.T","5631.T","5714.T","5801.T","5802.T","5803.T","5832.T","6098.T",
  "6103.T","6113.T","6178.T","6273.T","6301.T","6302.T","6305.T","6326.T",
  "6361.T","6366.T","6367.T","6473.T","6479.T","6501.T","6502.T","6503.T",
  "6504.T","6506.T","6645.T","6674.T","6701.T","6702.T","6703.T","6724.T",
  "6752.T","6753.T","6758.T","6762.T","6770.T","6857.T","6861.T","6902.T",
  "6952.T","6954.T","6971.T","6981.T","7003.T","7004.T","7011.T","7012.T",
  "7013.T","7201.T","7202.T","7203.T","7205.T","7211.T","7261.T","7267.T",
  "7269.T","7270.T","7272.T","7731.T","7733.T","7735.T","7751.T","7752.T",
  "7762.T","7832.T","7951.T","7974.T","8001.T","8002.T","8003.T","8015.T",
  "8031.T","8035.T","8053.T","8058.T","8233.T","8253.T","8267.T","8306.T",
  "8308.T","8309.T","8316.T","8411.T","8591.T","8601.T","8604.T","8630.T",
  "8697.T","8750.T","8766.T","8801.T","8802.T","8830.T","9001.T","9005.T",
  "9007.T","9008.T","9009.T","9020.T","9021.T","9022.T","9064.T","9101.T",
  "9104.T","9107.T","9201.T","9202.T","9433.T","9437.T","9531.T","9532.T",
  "9602.T","9613.T","9735.T","9766.T","9983.T","9984.T",
];

// KOSPI 50 — South Korea
const KOSPI50: string[] = [
  "005930.KS","000660.KS","035420.KS","005380.KS","051910.KS","028260.KS",
  "207940.KS","035720.KS","000270.KS","096770.KS","015760.KS","068270.KS",
  "105560.KS","055550.KS","032830.KS","086790.KS","003550.KS","017670.KS",
  "003490.KS","066570.KS","034020.KS","009150.KS","011200.KS","012330.KS",
  "024110.KS","006400.KS","010950.KS","033780.KS","000810.KS","011170.KS",
  "018260.KS","034730.KS","316140.KS","090430.KS","003620.KS","047050.KS",
  "030200.KS","259960.KS","036570.KS","010140.KS","000100.KS","004020.KS",
  "161390.KS","008770.KS","009540.KS","029780.KS","006360.KS","000120.KS",
  "001570.KS","078930.KS",
];

// TWSE top 50 — Taiwan
const TWSE50: string[] = [
  "2330.TW","2317.TW","2454.TW","2382.TW","2308.TW","2412.TW","3711.TW",
  "2881.TW","2882.TW","1303.TW","1301.TW","2886.TW","2891.TW","2885.TW",
  "2884.TW","2892.TW","2887.TW","5871.TW","2890.TW","5880.TW","2883.TW",
  "2888.TW","2880.TW","3045.TW","2303.TW","2357.TW","2379.TW","3008.TW",
  "4904.TW","2395.TW","2610.TW","2615.TW","2603.TW","2609.TW","1216.TW",
  "1402.TW","2002.TW","2207.TW","2408.TW","2049.TW","3034.TW","4938.TW",
  "8046.TW","6505.TW","1326.TW","2105.TW","2912.TW","5009.TW","6669.TW",
  "3037.TW",
];

// ASX 100 — Australia
const ASX100: string[] = [
  "29M.AX","360.AX","A2M.AX","ABB.AX","ABC.AX","AGL.AX","AIA.AX","ALD.AX",
  "ALL.AX","ALQ.AX","AMP.AX","AMC.AX","ANN.AX","ANZ.AX","APA.AX","APT.AX",
  "APX.AX","AQZ.AX","AST.AX","ASX.AX","AUB.AX","AWC.AX","AZJ.AX","BEN.AX",
  "BGA.AX","BHP.AX","BKL.AX","BLD.AX","BOQ.AX","BPT.AX","BRG.AX","BSL.AX",
  "CAR.AX","CBA.AX","CGF.AX","CHC.AX","CIM.AX","CNU.AX","COH.AX","CPU.AX",
  "CSL.AX","CSR.AX","CTD.AX","CWN.AX","DHG.AX","DXS.AX","EBO.AX","ELD.AX",
  "EML.AX","EVN.AX","FMG.AX","FPH.AX","GMG.AX","GPT.AX","GQG.AX","GUD.AX",
  "HLS.AX","HVN.AX","IAG.AX","IEL.AX","IFL.AX","IGO.AX","ILU.AX","IPH.AX",
  "JBH.AX","JHG.AX","JHX.AX","LLC.AX","LNK.AX","LOV.AX","LYC.AX","MFG.AX",
  "MIN.AX","MMS.AX","MPL.AX","MQG.AX","NAB.AX","NCM.AX","NEC.AX","NHF.AX",
  "NST.AX","NUF.AX","NWL.AX","NWS.AX","ORA.AX","ORG.AX","ORI.AX","OSH.AX",
  "OZL.AX","PLS.AX","PMV.AX","PPT.AX","QAN.AX","QBE.AX","RHC.AX","RIO.AX",
  "RMD.AX","RWC.AX","S32.AX","SCG.AX","SEK.AX","SGP.AX","SGR.AX","SHL.AX",
];

// Hang Seng 50 — Hong Kong
const HANGSENG50: string[] = [
  "0001.HK","0002.HK","0003.HK","0005.HK","0006.HK","0011.HK","0012.HK",
  "0016.HK","0017.HK","0019.HK","0027.HK","0066.HK","0083.HK","0101.HK",
  "0151.HK","0175.HK","0241.HK","0267.HK","0288.HK","0291.HK","0316.HK",
  "0322.HK","0386.HK","0388.HK","0669.HK","0688.HK","0700.HK","0762.HK",
  "0823.HK","0857.HK","0868.HK","0883.HK","0939.HK","0941.HK","0960.HK",
  "0968.HK","0981.HK","0992.HK","1038.HK","1044.HK","1093.HK","1109.HK",
  "1113.HK","1177.HK","1211.HK","1299.HK","1398.HK","1928.HK","1997.HK",
  "2018.HK",
];

// BSE Sensex 30 — India
const SENSEX30: string[] = [
  "ADANIENT.BO","ADANIPORTS.BO","APOLLOHOSP.BO","ASIANPAINT.BO","AXISBANK.BO",
  "BAJAJ-AUTO.BO","BAJFINANCE.BO","BAJAJFINSV.BO","BPCL.BO","BHARTIARTL.BO",
  "BRITANNIA.BO","CIPLA.BO","COALINDIA.BO","DIVISLAB.BO","DRREDDY.BO",
  "EICHERMOT.BO","GRASIM.BO","HCLTECH.BO","HDFCBANK.BO","HDFCLIFE.BO",
  "HEROMOTOCO.BO","HINDALCO.BO","HINDUNILVR.BO","ICICIBANK.BO","INDUSINDBK.BO",
  "INFY.BO","ITC.BO","JSWSTEEL.BO","KOTAKBANK.BO","LT.BO",
];

// NIFTY 50 additions — India (NSE)
const NIFTY50_EXTRA: string[] = [
  "ADANIENT.NS","ADANIPORTS.NS","APOLLOHOSP.NS","ASIANPAINT.NS","AXISBANK.NS",
  "BAJAJ-AUTO.NS","BAJFINANCE.NS","BAJAJFINSV.NS","BPCL.NS","BHARTIARTL.NS",
  "BRITANNIA.NS","CIPLA.NS","COALINDIA.NS","DIVISLAB.NS","DRREDDY.NS",
  "EICHERMOT.NS","GRASIM.NS","HCLTECH.NS","HDFCBANK.NS","HDFCLIFE.NS",
  "HEROMOTOCO.NS","HINDALCO.NS","HINDUNILVR.NS","ICICIBANK.NS","INDUSINDBK.NS",
  "INFY.NS","ITC.NS","JSWSTEEL.NS","KOTAKBANK.NS","LT.NS","M&M.NS",
  "MARUTI.NS","NESTLEIND.NS","NTPC.NS","ONGC.NS","POWERGRID.NS","RELIANCE.NS",
  "SBIN.NS","SBILIFE.NS","SHREECEM.NS","SUNPHARMA.NS","TATACONSUM.NS",
  "TATAMOTORS.NS","TATASTEEL.NS","TCS.NS","TECHM.NS","TITAN.NS","ULTRACEMCO.NS",
  "UPL.NS","WIPRO.NS",
];

// SET 50 — Thailand
const SET50: string[] = [
  "ADVANC.BK","AOT.BK","AWC.BK","BAM.BK","BANPU.BK","BBL.BK","BCH.BK",
  "BCP.BK","BDMS.BK","BEC.BK","BH.BK","BJC.BK","BTS.BK","CBG.BK","CENTEL.BK",
  "COM7.BK","CPALL.BK","CPF.BK","CPN.BK","CRC.BK","DELTA.BK","DTAC.BK",
  "EA.BK","EGCO.BK","GLOBAL.BK","GPSC.BK","GULF.BK","HMPRO.BK","ICHI.BK",
  "INTUCH.BK","IRPC.BK","IVL.BK","JMT.BK","JMART.BK","KCE.BK","KKP.BK",
  "KTB.BK","KBANK.BK","KTC.BK","LH.BK","MAJOR.BK","MBK.BK","MINT.BK",
  "MTC.BK","OR.BK","OSP.BK","PTT.BK","PTTEP.BK","PTTGC.BK","RATCH.BK",
];

// STI 30 — Singapore
const STI30: string[] = [
  "C6L.SI","C31.SI","C09.SI","C38U.SI","CIT.SI","D01.SI","D05.SI","E5H.SI",
  "F34.SI","G13.SI","H78.SI","J36.SI","J37.SI","K71U.SI","ME8U.SI","N2IU.SI",
  "O39.SI","O32.SI","Q0F.SI","S58.SI","S63.SI","S68.SI","T39.SI","U09.SI",
  "U11.SI","U14.SI","V03.SI","W09.SI","Y92.SI","Z74.SI",
];

// KLCI 30 — Malaysia
const KLCI30: string[] = [
  "1015.KL","1023.KL","1066.KL","1082.KL","1155.KL","1295.KL","1562.KL",
  "1818.KL","2445.KL","3182.KL","3816.KL","4197.KL","4329.KL","4515.KL",
  "4707.KL","4863.KL","5099.KL","5182.KL","5347.KL","6012.KL","6033.KL",
  "6888.KL","7022.KL","7052.KL","7084.KL","7277.KL","8869.KL","1961.KL",
  "5681.KL","5819.KL",
];

// IDX30 — Indonesia
const IDX30: string[] = [
  "AALI.JK","ADRO.JK","AKRA.JK","AMRT.JK","ASII.JK","BBCA.JK","BBNI.JK",
  "BBRI.JK","BBTN.JK","BKSL.JK","BMRI.JK","BRPT.JK","BSDE.JK","CPIN.JK",
  "EXCL.JK","GGRM.JK","HMSP.JK","HRUM.JK","ICBP.JK","INDF.JK","INKP.JK",
  "INTP.JK","ITMG.JK","JPFA.JK","KLBF.JK","LPPF.JK","MDKA.JK","MEDC.JK",
  "MIKA.JK","SMGR.JK",
];

// PSEi 30 — Philippines
const PSEI30: string[] = [
  "AC.PS","AGI.PS","ALI.PS","AP.PS","BLOOM.PS","BDO.PS","CNVRG.PS","DMC.PS",
  "DNL.PS","EMP.PS","GLO.PS","GTCAP.PS","ICT.PS","JFC.PS","JGS.PS","MBT.PS",
  "MER.PS","MPI.PS","MONDE.PS","NIKL.PS","PGOLD.PS","PIZZA.PS","RLC.PS",
  "RRHI.PS","SECB.PS","SM.PS","SMC.PS","SMPH.PS","SCC.PS","TEL.PS",
];

// Bovespa top 40 — Brazil
const BOVESPA40: string[] = [
  "ABEV3.SA","ASAI3.SA","AZUL4.SA","B3SA3.SA","BBAS3.SA","BBDC3.SA","BBDC4.SA",
  "BEEF3.SA","BPAC11.SA","BRAP4.SA","BRFS3.SA","BRKM5.SA","CCRO3.SA","CIEL3.SA",
  "CMIG4.SA","COGN3.SA","CPFE3.SA","CSAN3.SA","CSNA3.SA","CYRE3.SA","EGIE3.SA",
  "ELET3.SA","ELET6.SA","EMBR3.SA","ENBR3.SA","ENEV3.SA","ENGI11.SA","EQTL3.SA",
  "FLRY3.SA","GNDI3.SA","GOAU4.SA","GOLL4.SA","HAPV3.SA","HYPE3.SA","IGTA3.SA",
  "IRBR3.SA","ITSA4.SA","ITUB4.SA","JHSF3.SA","JBSS3.SA",
  "KLBN11.SA","MGLU3.SA","MRFG3.SA","MRVE3.SA","MULT3.SA",
  "NTCO3.SA","PCAR3.SA","PETR3.SA","PETR4.SA","PRIO3.SA",
  "QUAL3.SA","RADL3.SA","RAIL3.SA","RDOR3.SA","RENT3.SA",
  "SBSP3.SA","SLCE3.SA","SMFT3.SA","SUZB3.SA","TAEE11.SA",
  "TOTS3.SA","UGPA3.SA","USIM5.SA","VALE3.SA","VIVT3.SA",
  "WEGE3.SA","YDUQ3.SA",
];

// IPC top 25 — Mexico
const IPC25: string[] = [
  "ALFAA.MX","ALSEA.MX","AMX.MX","ASURB.MX","BIMBOA.MX","BOLSAA.MX","CEMEXCPO.MX",
  "CUERVO.MX","ELEKTRA.MX","FEMSAUBD.MX","FUNO11.MX","GCARSOA1.MX","GFINBURO.MX",
  "GFNORTEO.MX","GMEXICOB.MX","GRUMAB.MX","KIMBERA.MX","LABB.MX","LIVEPOLC-1.MX",
  "MEGACPO.MX","OMAB.MX","PINFRA.MX","RCENTROA.MX","TLEVISACPO.MX","WALMEX.MX",
];

// Merval top 20 — Argentina
const MERVAL20: string[] = [
  "ALUA.BA","BBAR.BA","BMA.BA","BYMA.BA","CEPU.BA","COME.BA","CRES.BA",
  "CVH.BA","EDN.BA","GGAL.BA","HARG.BA","IRSA.BA","LOMA.BA","METR.BA",
  "MIRG.BA","PAMP.BA","SUPV.BA","TECO2.BA","TGNO4.BA","YPFD.BA",
];

// TA-35 — Israel
const TA35: string[] = [
  "AMOT.TA","AZRG.TA","BONY.TA","DSCT.TA","ELCO.TA","ENLT.TA","ESLT.TA",
  "FIBI.TA","FTAL.TA","GFC.TA","ICL.TA","ISCN.TA","LSCO.TA","MGOR.TA",
  "MZTF.TA","NICE.TA","NVMI.TA","ORLY.TA","POLI.TA","PRSK.TA","RATBP.TA",
  "RPAC.TA","SAMI.TA","SMTO.TA","SPGE.TA","TEVA.TA","TFRD.TA","TLGN.TA",
  "TSEM.TA","WSMK.TA","XLBI.TA","YAYN.TA","YSAS.TA","RDHL.TA","SFET.TA",
];

// Tadawul top 30 — Saudi Arabia
const TADAWUL30: string[] = [
  "1010.SR","1020.SR","1050.SR","1060.SR","1120.SR","1140.SR","1150.SR",
  "1180.SR","2010.SR","2020.SR","2030.SR","2040.SR","2050.SR","2060.SR",
  "2080.SR","2090.SR","2110.SR","2120.SR","2150.SR","2180.SR","2190.SR",
  "2222.SR","2280.SR","2290.SR","2310.SR","2380.SR","4001.SR","4200.SR",
  "4260.SR","7010.SR",
];

// EGX 30 — Egypt
const EGX30: string[] = [
  "ABUK.CA","ACGC.CA","ADIB.CA","ALCN.CA","AUTO.CA","BIOC.CA","CCAP.CA",
  "CIEB.CA","COSG.CA","COMI.CA","DCAP.CA","EFIH.CA","EGBE.CA","EGTS.CA",
  "EZDK.CA","FWRY.CA","HELI.CA","HRHO.CA","IMTC.CA","ISPH.CA","JUFO.CA",
  "MNHD.CA","MPCI.CA","OCDI.CA","ORTE.CA","PHDC.CA","PIOB.CA","PRCL.CA",
  "SKPC.CA","TMGH.CA",
];

// ─── Main expansion function ──────────────────────────────────────────────────

export async function expandUniverse(): Promise<{
  inserted: number;
  skipped: number;
  total: number;
  byRegion: Record<string, number>;
}> {
  // Build deduplicated master list
  const allLists: string[][] = [
    SP500, NASDAQ100, RUSSELL1000_EXTRA,
    TSX60,
    DAX40, MDAX50, CAC40, FTSE100, FTSEMIB, AEX25, SMI20, IBEX35,
    OMX30, OBX25, OMXC25, OMXH25, ATX20, BEL20, PSI20,
    WIG20, BUX20, PX15, BET20, BIST30,
    NIKKEI225, KOSPI50, TWSE50, ASX100, HANGSENG50,
    SENSEX30, NIFTY50_EXTRA, SET50, STI30, KLCI30, IDX30, PSEI30,
    BOVESPA40, IPC25, MERVAL20,
    TA35, TADAWUL30, EGX30,
  ];

  const allTickers = [...new Set(allLists.flat())];
  console.log(`[universeExpansion] Starting expansion: ${allTickers.length} unique tickers`);

  // Get existing tickers — NEVER touch these
  const existingRows = sqlite.prepare("SELECT ticker FROM universe").all() as { ticker: string }[];
  const existing = new Set(existingRows.map(r => r.ticker));
  console.log(`[universeExpansion] Existing tickers in DB: ${existing.size}`);

  const newTickers = allTickers.filter(t => !existing.has(t));
  console.log(`[universeExpansion] New tickers to insert: ${newTickers.length}`);

  // Prepare INSERT OR IGNORE (DO NOTHING on conflict — guaranteed additive)
  const insertStmt = sqlite.prepare(`
    INSERT OR IGNORE INTO universe
      (ticker, name, exchange, country, region, currency, sector, industry, asset_type, is_active, added_at)
    VALUES
      (?, ?, ?, ?, ?, ?, NULL, NULL, ?, 1, datetime('now'))
  `);

  let inserted = 0;
  let skipped = 0;
  const byRegion: Record<string, number> = {};

  for (const ticker of newTickers) {
    try {
      const meta = metaFromTicker(ticker);
      const result = insertStmt.run(
        ticker,
        ticker, // name = ticker initially; scheduler backfills real name on first refresh
        meta.exchange,
        meta.country,
        meta.region,
        meta.currency,
        meta.assetType,
      );
      if (result.changes > 0) {
        inserted++;
        byRegion[meta.region] = (byRegion[meta.region] ?? 0) + 1;
      } else {
        skipped++;
      }
    } catch (e: any) {
      skipped++;
    }
  }

  const totalRow = sqlite.prepare("SELECT COUNT(*) as c FROM universe WHERE is_active = 1").get() as { c: number };
  const total = totalRow.c;

  console.log(`[universeExpansion] Done. Inserted: ${inserted}, Skipped: ${skipped}, Total active: ${total}`);
  console.log(`[universeExpansion] By region:`, JSON.stringify(byRegion));

  return { inserted, skipped, total, byRegion };
}
