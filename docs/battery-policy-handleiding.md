# HomeWizard Batterij-planning — Installatie & Instellingen

Deze handleiding legt uit hoe je het **Batterij-planning**-apparaat toevoegt en elke
instelling configureert. Het apparaat bouwt een 24-uurs optimalisatieplan (laden /
ontladen / vasthouden) voor je HomeWizard Plug-In Batterij op basis van dynamische
prijzen, een PV-voorspelling en je huisverbruik.

---

## 1. Vereisten

- Een **HomeWizard P1-meter** toegevoegd via de **Energy (v2)**-API.
- Eén of meer **HomeWizard Plug-In Batterijen** in dezelfde Homey.
- (Optioneel) Een dynamisch energiecontract voor prijsarbitrage.

## 2. Apparaat toevoegen

1. Homey → **Apparaten → + (Toevoegen) → HomeWizard → Batterij-planning**.
2. **Selecteer batterij** — kies de P1-meter / batterij die deze planner aanstuurt.
3. **Beleid configureren** — rond het koppelen af. Alles is later in de instellingen aan te passen.

## 3. Bediening op de tegel (geen menu nodig)

Deze staan op de apparaat-tegel / bediening, niet in de instellingenpagina:

- **Beleid ingeschakeld** — hoofdschakelaar voor de hele planner.
- **Automatisch toepassen** — *aan* = het plan wordt automatisch op de batterij toegepast. *Uit* = alleen advies (de aanbevolen modus wordt getoond maar niet afgedwongen).
- **Beleidsmodus** — `Uit` · **`Dynamische prijzen`** (standaard, dynamisch contract) · `Vaste prijzen` (vast contract) · `Dynamische prijzen (V2 — na saldering)` · `Piekbeveiliging`.

> Snelstart: zet **Beleidsmodus = Dynamische prijzen**, **Beleid ingeschakeld = aan**,
> en **Automatisch toepassen = aan** zodra je het plan vertrouwt.

## 4. Live PV-productie doorgeven (flow)

De planner werkt het best als hij je **actuele** zonneproductie kent. Staan je
omvormer/panelen in Homey, stuur de waarde dan met een flow:

- **Actie-kaart:** *Update PV-productie* (`power`, in Watt).
- **Voorbeeldflow:** *Als* PV-vermogen gewijzigd → *Dan* Batterij-planning: **Update PV-productie** = `[huidig PV-vermogen in watt]`.

Deze live-waarde traint ook de PV-schatting na verloop van tijd.

---

## 5. Overzicht van instellingen

Open het apparaat → **Instellingen (⚙)**. De instellingen zijn precies zo gegroepeerd
als hieronder. Standaardwaarde en bereik staan tussen haakjes.

### Batterij-apparaat

- **Gekoppelde P1 (Energy v2)** — toont de gekoppelde P1-meter. Ingesteld tijdens koppelen.

### Policy-gedrag

- **Policy-controle-interval** *(15 min · 5–60)* — hoe vaak het plan opnieuw wordt berekend.
- **Minimale zekerheid** *(55 % · 0–100)* — onder dit voorspellingsvertrouwen blijft de planner voorzichtig.

### Tariefconfiguratie

- **Type tarief** *(`fixed`)* — `fixed` (vast) of `dynamic` (dynamisch). Kies `dynamic` voor uur-/kwartiermarktprijzen.
- **Piekuren** *(`17:00-21:00`)* — gebruikt voor vaste/piek-logica.
- **Dynamische prijsprovider inschakelen** *(uit)* — aanzetten om live dynamische prijzen op te halen.
- **Min/max prijzen strikt respecteren** *(uit)* — *aan* = nooit laden boven *Maximale laadprijs* / ontladen onder *Minimale ontlaadprijs*, ook al wil de optimizer dat. *Uit* = de optimizer mag overrulen als het duidelijk winstgevend is.
- **Opportunistisch laden spread-vermenigvuldiger** *(2.0× · 1.0–5.0)* — hoe agressief extra-goedkope laadmomenten gepakt worden.
- **Opportunistisch ontladen spread-drempel** *(−0.05 €/kWh · −0.1…−0.01)* — benodigde spread vóór opportunistisch ontladen.
- **Maximale laadprijs** *(0.12 €/kWh)* — plafond voor laden uit het net.
- **Minimale ontlaadprijs** *(0.22 €/kWh)* — bodem voor ontladen naar net/huis.
- **Minimale arbitragewinst** *(0.01 €/kWh · 0–0.15)* — minimale spread per kWh voordat een laad→ontlaad-cyclus de moeite waard is.
- **Batterij-efficiëntie (RTE)** *(0.78 · 0.5–0.97)* — round-trip-rendement; beïnvloedt het break-even-punt.

### Weersvoorspelling

- **Breedtegraad** *(0 · −90…90)* — **zet op je thuis-breedtegraad** (bijv. 52.020). Nodig voor de PV/zon-voorspelling.
- **Lengtegraad** *(0 · −180…180)* — **zet op je thuis-lengtegraad** (bijv. 5.040).
- **Update-interval weersvoorspelling** *(3 u · 1–24)* — hoe vaak de voorspelling ververst.

### Batterijlimieten

- **Minimale batterij-%** *(0 % · 0–50)* — reservebodem.
- **Maximale batterij-%** *(100 % · 80–100)* — laadplafond.
- **Batterijcycli sparen** *(aan)* — vermijdt laagwaardige cycli om de batterij langer mee te laten gaan.
- **Batterij cycluskosten** *(0.075 €/kWh · 0–0.15)* — slijtagekosten per gecyclede kWh; de optimizer moet dit overtreffen om te handelen.
- **Piekbeveiliging drempelwaarde (W)** *(0 · 0–10000)* — ontlaadt om netimport onder deze waarde te houden (0 = uit).
- **PV laadkosten** *(`free`)* — `free` = zonneladen kost niets. `feedin` = waardeer zon tegen het terugleveringstarief (het heeft een opportuniteitskost).
- **Netto terugleverwaarde** *(0.08 €/kWh · 0–0.3)* — gebruikt wanneer *PV laadkosten* = `feedin`.

### PV-schatting

- **PV-schatting inschakelen** *(uit)* — aanzetten om je zonneopbrengst te voorspellen.
- **PV-piekvermogen (W)** *(0 · 0–20000)* — totaal paneel-Wp (bijv. 3600).
- **Paneel helling (°)** *(35 · 0–90)* — dakhoek (0 = plat, 90 = verticaal).
- **Paneel azimuth (°)** *(0 · −90…90)* — oriëntatie: **0 = Zuid**, negatief = Oost, positief = West.
- **Prestatieratio (PR)** *(0.75 · 0.5–0.9)* — systeemverliezen (omvormer, bekabeling, vervuiling).

### Solcast PV-voorspelling (optioneel)

- **Solcast gebruiken voor PV-voorspelling** *(uit)* — optionele tweede voorspellingsbron.
- **Ongewogen OM+Solcast-mix (50/50)** *(aan)* — mengt Open-Meteo en Solcast gelijk (aanbevolen). *Uit* = gewogen/legacy-gedrag.
- **Solcast Resource ID** — uit je gratis Solcast-account.
- **Solcast API-sleutel** — uit je gratis Solcast-account. Leeg laten = alleen Open-Meteo.

### KNMI-stationdata

- **KNMI API-sleutel** — optionele gratis KNMI Open-Data-sleutel; voegt grond-waarheid van het dichtstbijzijnde station toe voor scherpere voorspellingen.

### Geavanceerd

- **Gedetailleerde logging inschakelen** *(uit)* — uitgebreide diagnostiek (alleen voor probleemoplossing).
- **Policy-beslissingen naar tijdlijn sturen** *(uit)* — schrijft elke beslissing naar de Homey-tijdlijn.

### 24-uurs planning

- **Prijsresolutie** *(`15min`)* — `15min` of `1h`. Stem af op je contract: kwartiermarkten → `15min`, uur → `1h`. Prijzen worden intern altijd op 15-min opgehaald.

---

## 6. Aanbevolen vertrekpunt (dynamisch contract + zon)

1. **Beleidsmodus** = Dynamische prijzen · **Beleid ingeschakeld** = aan · **Automatisch toepassen** = uit (tot je het vertrouwt).
2. **Type tarief** = `dynamic` · **Dynamische prijsprovider inschakelen** = aan · **Prijsresolutie** = passend bij je contract.
3. **Breedtegraad / Lengtegraad** = je thuis-coördinaten.
4. **PV-schatting inschakelen** = aan · zet **PV-piekvermogen**, **Helling**, **Azimuth**, **PR**.
5. Maak de **Update PV-productie**-flow zodat live zon wordt doorgegeven.
6. Laat **Maximale laadprijs**, **Minimale ontlaadprijs**, **Cycluskosten** en **Batterij-efficiëntie** eerst op standaard; stem af na een paar dagen het plan te volgen.
7. (Optioneel) Voeg **Solcast**-sleutels en/of een **KNMI**-sleutel toe voor scherpere voorspellingen.
8. Ziet het plan er goed uit, zet dan **Automatisch toepassen = aan**.

> Tip: de **diagnosepagina** van het apparaat toont het volledige 24-uursplan, de
> prijsrange, de PV-voorspelling en de reden per slot — gebruik die om de
> bovenstaande instellingen te begrijpen en af te stemmen.
