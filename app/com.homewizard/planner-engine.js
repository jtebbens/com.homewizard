(function(window){
  // Minimal PlannerEngine stub
  function PlannerEngine(settings){
    this.settings = Object.assign({
      battery_efficiency: 0.75,
      min_profit_margin: 0.02,
      max_charge_price: 0.15,
      min_discharge_price: 0.30,
      min_soc: 10,
      max_soc: 95,
      tariff_type: 'dynamic'
    }, settings || {});
  }

  PlannerEngine.prototype.getRecommendationForHour = function(ctx, allPrices) {
    // ctx: { hour, price, isPeak, isCheap, hasSun, projectedSOC, hoursFromNow }
    const s = this.settings;
    // If no price known, prefer PV when sun available
    if (ctx.price === null || typeof ctx.price !== 'number') {
      return ctx.hasSun ? 'pv_only' : 'standby';
    }

    // If peak badge, discharge
    if (ctx.isPeak) return 'discharge';
    // If cheap badge, charge
    if (ctx.isCheap) return 'charge';

    // Price-based heuristics
    if (ctx.price >= s.min_discharge_price) return 'discharge';
    if (ctx.price <= s.max_charge_price) return 'charge';

    // PV window
    if (ctx.hasSun) return 'pv_only';

    return 'standby';
  };

  window.PlannerEngine = PlannerEngine;
})(window);
