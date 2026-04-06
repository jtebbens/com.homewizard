# ExplainabilityEngine

- `generateExplanation()` builds a `reasons[]` array; each reason has `category`, `icon`, `text`, `impact`, `supportedMode`
- **Weather PV tekst:** gebruik `weather.pvKwhRemaining` (resterend vandaag) boven `weather.pvKwhToday` (totaal) — totaal is misleidend als de dag al half voorbij is
- **Redundantie PV + delay-charge:** als `_delayCharge` actief is én PV-overschot al een `preserve`-reden heeft toegevoegd, sla de aparte strategy-reden over — ze zeggen hetzelfde
- **Geen conclusie in reason-tekst:** schrijf niet "Stand-by aanbevolen." in een reason; dat is de aanbeveling zelf, niet een reden
- `_addDelayChargeReasons` checkt `reasons.some(r => r.category === 'pv' && r.supportedMode === 'preserve')` om redundantie te voorkomen
- **`inputs.optimizerSlots`** — optimizer schedule (`_schedule.slots`) wordt door `_runPolicyCheck` in `inputs` gezet vóór de `generateExplanation()`-aanroep; beschikbaar als `[{timestamp, action, price, socProjected, consumptionW, sampleCount}]`
- **`inputs.consumptionW`** — geschat huisverbruik (W) voor het huidige uur, via `learningEngine.getPredictedConsumption(now)`. Gebruikt in `_addArbitrageReasons` voor ontlaad-opbrengst annotatie.
- **Standby bij preserve:** `_addModeSpecificReasons` toont de volgende geplande ontlaadmomenten (tot 3) met tijdstip en prijs — "Batterij bewaard voor geplande ontlaadbeurten: 19:00 (€0.381), ..."
- **to_full:** `_addModeSpecificReasons` toont laadrijs, beste toekomstige ontlaadslot en nettomarge na cycluskosten — "Laden van net: €0.121 → ontladen 19:00 bij €0.341. Nettomarge: €0.145/kWh."
- **Goedkoop laden (`_addArbitrageReasons`):** voegt beste toekomstige discharge-slot toe uit `inputs.optimizerSlots` — "Laden is goedkoop: prijs (€0.121) onder break-even (€0.243). Beste ontlaadslot: 19:00 bij €0.381 → nettomarge ~€0.260/kWh."
- **Winstgevend ontladen (`_addArbitrageReasons`):** voegt geschat verbruik en uurlijkse opbrengst toe — "Ontladen is winstgevend: prijs (€0.381) boven break-even (€0.121). Geschat verbruik: 0.8 kW → ~€0.305/u."
- **Tijdzone:** gebruik `toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' })` voor uur-checks (avonduren 17–22, nachturen 2–6) — NIET `getHours()` want dat geeft UTC terug op Homey.
