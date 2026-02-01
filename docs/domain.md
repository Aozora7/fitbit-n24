# Non-24-hour sleep-wake disorder and circadian rhythm visualization

## What is N24?

Non-24-hour sleep-wake disorder (N24SWD, or simply N24) is a chronic circadian rhythm disorder in which the body's internal clock runs on a cycle longer than 24 hours. The endogenous circadian period (tau) is not entrained to the 24-hour light-dark cycle, causing the sleep-wake pattern to drift progressively later each day.

A person with a tau of 24.7 hours will sleep about 42 minutes later each day. Over the course of roughly 34 days, their sleep window completes a full revolution around the clock — they cycle through sleeping at night, then in the morning, then afternoon, evening, and back to night. This is often called "free-running."

N24 is most common in totally blind individuals (who lack the light input needed to entrain the clock) but also occurs in sighted people. Prevalence estimates for the sighted population are uncertain but likely underdiagnosed.

## How N24 manifests in sleep data

### The core pattern

When plotted on an actogram, N24 produces a characteristic diagonal stripe pattern. Sleep blocks march to the right (later) by a consistent amount each day. The slope of this diagonal directly reveals the period: steeper = faster drift = longer tau.

### Real-world complications

The textbook diagonal is rarely clean in practice:

- **Forced wake times**: Work, school, or social obligations may force the person to wake before their circadian sleep window ends. This creates truncated sleep blocks on some days and can produce a "zigzag" pattern where sleep appears to jump backward on workdays.

- **Naps and fragmented sleep**: When the circadian night falls during daytime obligations, the person may only manage short naps. These appear as small scattered blocks rather than one consolidated sleep period.

- **Missing data**: The tracker may not be worn, or the person may not record some sleep episodes. Gaps in the actogram make pattern detection harder.

- **Alarm-based truncation**: Fitbit records the actual sleep period, so alarm-forced awakenings show up as shorter blocks at times that conflict with the circadian prediction.

- **Variable period**: Tau is not perfectly constant. It can shift with seasons (photoperiod changes), medication (melatonin, light therapy attempts), illness, or other factors. The diagonal may curve or change slope over months.

- **Entrainment attempts**: Periods where the person temporarily entrains (locks to 24 hours) through light therapy or melatonin appear as horizontal streaks in the actogram before the pattern resumes drifting.

## Why standard charts fail for N24

### Bar charts

A conventional sleep bar chart shows each day's sleep as a bar at a fixed position on a 24-hour timeline. For someone with N24, the bars migrate across the chart over weeks, making it impossible to see the drift pattern because the X axis resets every day.

### Weekly/monthly aggregations

Heatmaps or histograms that aggregate sleep times over a week or month average away the drift. A month where sleep circled from nighttime through daytime and back looks like the person sleeps equally at all hours, which is technically true but completely misses the structure.

### Clock-face plots

Circular plots with 24 hours around the perimeter show what time sleep occurs but not how it changes day-to-day. The temporal progression is lost.

## The actogram

The actogram (also called a raster plot or sleep raster) is the standard visualization in chronobiology research. It was developed for analyzing circadian rhythms in laboratory animals and has been adapted for human sleep analysis.

### Structure

- Each row represents one calendar day
- The horizontal axis represents time of day (usually 24 hours)
- Sleep periods are drawn as filled blocks at their time position
- Days stack vertically, creating a grid where temporal patterns emerge as visual shapes

### Why it works for N24

The progressive daily delay in sleep times creates a diagonal line sloping downward-right (if oldest days are at top) or upward-right (if newest days are at top). The angle of this diagonal immediately reveals:

- **Period length**: Steeper slope = longer tau = faster drift
- **Consistency**: A straight diagonal = stable period; curvature = changing period
- **Entrainment**: Horizontal streaks = the clock is locked to 24 hours
- **Disruptions**: Scattered blocks or gaps = noisy data or forced schedules

### Double-plotted actogram

A variant where each row spans 48 hours instead of 24. Each day's data appears twice: once on the right half of its own row and again on the left half of the next row. This makes it much easier to see patterns that cross the midnight boundary, since the visual continuity is preserved. The trade-off is that the horizontal axis is compressed by half.

Double-plotting is standard practice in circadian research because it eliminates the visual discontinuity at midnight that makes single-plotted actograms harder to read for free-running rhythms.

## Estimating the circadian period

### The problem

Given noisy sleep data with forced wake times, naps, and gaps, estimate the underlying circadian period (tau) and predict where the circadian night falls on any given day. The period is not constant — it varies with seasons, light exposure, medication, and other factors — so a single global estimate is insufficient.

### Phase markers

The sleep midpoint (halfway between sleep onset and wake time) is used as a proxy for the circadian phase. In chronobiology, more precise phase markers include core body temperature minimum (CBTmin) or dim light melatonin onset (DLMO), but these require laboratory measurement. The sleep midpoint is the best available marker from consumer wearable data.

### Sleep quality as a filter

Not all sleep records are equally informative. When the Fitbit v1.2 API provides sleep stage data, the proportion of REM and deep sleep is the strongest signal for whether a sleep with a long duration was circadian-aligned. Fitbit's own sleep score available in the official app highly correlates with circadian-aligned sleep, however, Fitbit's sleep API does not provide it.

This app attempts its own sleep quality score based on sleep duration, deep + REM sleep percentage, and time asleep vs time in bed as a rough approximation of Fitbit's score.

### Tiered anchor selection

Records are classified into three tiers based on duration and quality:

- **Tier A** : High-confidence anchors that almost certainly represent circadian sleep
- **Tier B** : Moderate-confidence anchors
- **Tier C** : Used only for gap-filling when fewer than 25% of days are covered by A and B anchors

When multiple records exist for the same calendar day, only the highest-quality one is kept.

### Outlier rejection

After initial anchor selection, a global linear regression is fit and records with residuals exceeding 8 hours are removed. This catches forced-schedule sleeps that passed the duration and quality thresholds but have midpoints far from the true circadian phase.

### Sliding-window weighted regression

Rather than fitting a single line to the entire dataset (which assumes constant tau), the app uses a 90-day Gaussian-weighted sliding window stepped daily:

1. For each calendar day, collect all anchors within +/- 45 days
2. Weight each anchor by a Gaussian (sigma = 30 days) multiplied by its tier weight
3. Fit weighted least squares: midpoint = slope \* dayIndex + intercept
4. Local tau = 24 + slope

This produces a per-day tau estimate that captures gradual changes in the circadian period over months and years. The circadian overlay follows these local estimates, so the predicted night band curves rather than being a straight diagonal.

A composite confidence score for each day combines anchor density (40%), mean anchor quality (30%), and residual spread (30%). The circadian overlay uses this to modulate opacity — regions with dense, high-quality data are drawn more prominently.

### Current limitations

**Midpoint as phase marker**: Using the midpoint of the sleep record assumes sleep is roughly symmetric around the circadian nadir. In practice, sleep onset and offset relate differently to the underlying circadian phase, and forced wake times can shift the midpoint away from the true circadian center.

**8-hour assumed duration**: The circadian overlay uses a fixed 8-hour window regardless of actual sleep durations.

**No change-point detection**: The sliding window captures gradual tau changes but cannot detect sudden phase shifts from jet lag, medication changes, or entrainment episodes. These appear as brief anomalies in the overlay rather than clean transitions.

### Approaches not yet implemented

**Chi-squared periodogram**: A frequency-domain method from chronobiology that estimates the dominant period in time-series data. More robust to noise than regression because it uses all the data simultaneously rather than just midpoints. Variants include the Lomb-Scargle periodogram (handles uneven sampling) and the Sokolove-Bushell periodogram.

**Change-point detection**: Statistical methods to identify moments where the underlying period shifts. Could be combined with the sliding-window approach to detect and label entrainment episodes.

**Bayesian estimation**: Model the circadian phase as a latent variable with a prior on tau and uncertainty on each observation. This naturally handles missing data and variable confidence.

## Counting full revolutions

One way to validate a tau estimate is to count how many times the sleep pattern completes a full revolution around the 24-hour clock. If the data spans D days and there are R full revolutions:

```
tau = D / (D - R) * 24
```

Or equivalently, the drift per day is `24 * R / D` hours, so `tau = 24 + 24R/D`.

For example, with ~1300 days of data and ~49 full revolutions:

```
drift = 24 * 49 / 1300 = 0.905 hours/day = 54.3 min/day
tau = 24 + 0.905 = 24.905 hours
```

This manual counting method is crude but provides a useful sanity check against algorithmic estimates.

## Related concepts

### Zeitgebers

Environmental cues that entrain the circadian clock. The strongest zeitgeber for humans is light. Others include social schedules, meal times, and exercise. People with N24 have lost effective entrainment to these cues.

### Phase response curve

The circadian clock's sensitivity to zeitgebers varies by time of day. Light exposure in the early subjective morning advances the clock; light in the early subjective evening delays it. This is why light therapy timing matters for treatment attempts.

### Circadian vs. homeostatic sleep drive

Sleep is regulated by two processes: the circadian clock (Process C), which creates a ~24h oscillation in sleepiness, and the homeostatic sleep drive (Process S), which builds up with wakefulness. In N24, Process C drifts out of sync with the desired schedule, but Process S still accumulates normally. This is why people with N24 can sometimes force themselves to sleep "on schedule" — homeostatic pressure is high enough — but the sleep quality is poor because it conflicts with the circadian phase.

### Desynchrony symptoms

When the circadian night falls during waking hours (the "bad" part of the cycle), people with N24 typically experience extreme fatigue, cognitive impairment, mood disruption, gastrointestinal issues, and a general feeling of severe jet lag. When the cycle realigns with a nighttime schedule (the "good" part), they feel relatively normal. This cyclical variation in functioning is a hallmark of the disorder.

## References and resources

- Sack RL, et al. "Circadian rhythm sleep disorders" (2007) - Clinical review covering N24 diagnosis and treatment
- Uchiyama M, Lockley SW. "Non-24-hour sleep-wake rhythm disorder in sighted and blind patients" (2015) - Comprehensive review of N24
- Refinetti R. "Circadian Physiology" (3rd ed.) - Textbook covering actogram methodology and period analysis
- Sokolove PG, Bushell WN. "The chi square periodogram: its utility for analysis of circadian rhythms" (1978) - Original chi-squared periodogram method
- circadiaware.github.io - Community resources about circadian rhythm disorders
