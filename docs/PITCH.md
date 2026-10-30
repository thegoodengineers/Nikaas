# Nikaas — 3-minute pitch script (v2)
*v2 by Chirag at 18:00, rebuilt from Bhumika's draft: same structure and speakers, claims corrected, Live Drill added.
Every number below is in `runs/` (list at the end). Speakers marked "decide" are open; final by 06:00.*

---

## Before going on stage (step 0)

- On the laptop, open the **HTTPS** address https://nikaas-webbucket-hbkfctr0cw8s.s3.ap-south-1.amazonaws.com/index.html (not the http:// one: the QR code sends phones to whatever address the laptop has open, and phone alerts, GPS and the camera only work over HTTPS).
- On the laptop, open the Live drill page (`#/drill`) and press **Start over**, so no phone shows an old alert.
- Have a second tab on Home (`#/`) and a third on the Twin (`#/twin`).
- One phone taped beside the classroom door, open on `#/sign`, door chosen: the live exit sign.
- If the Wi-Fi fails: open the site with `?demo=1` (saved runs, no network) and skip the Live Drill.

---

## 0:00 – 0:20 · Problem  *(Bhumika)*

> "Twenty-two students died in the 2019 Surat coaching-centre fire after the escape stair burned.
> Twenty-three people died on one overloaded footbridge at Elphinstone Road in Mumbai.
> On the 4th of June 2025, eleven people were killed outside Chinnaswamy Stadium in Bengaluru.
> Every building has an evacuation map on the wall. It says one thing: go to the nearest exit.
> When everyone does, one door jams while the others stand empty."

---

## 0:20 – 0:35 · Product  *(Chirag)*

> "We built Nikaas, Hindi for 'exit'. Photograph the exit map on the wall, and Nikaas turns it into a live
> model of the building, simulates every person, and gives every room the exit that gets everyone out fastest."

---

## 0:35 – 1:35 · Live demo  *(Chirag drives, Bhumika narrates)*

**Step 1: Home, already evacuating.** Tap the green sign at the main entrance.
> "This is the IIT Kharagpur Nehru Museum, 507 people. A fire blocks the main entrance.
> Nikaas re-plans every room in seconds. With today's rule, everyone is out in 318 seconds;
> with the Nikaas plan, 223.5."

**Step 2: Live Drill.** Show the QR code on `#/drill`.
> "Now it is your turn. Scan this and pick the room you are in. Your phone now shows your own exit
> and how far it is."

Press **Set a fire** at West steps.
> "A fire at the West steps. Every phone that was going that way just turned red and got a new route.
> And the sign on that door"  *(point at the taped phone)*  "now says: do not use, go to the Verandah door."

---

## 1:35 – 2:15 · Proof  *(speaker: decide)*

> "We did not guess these numbers. The SFPE fire-engineering handbook works one evacuation out by hand:
> 245.2 seconds. Our simulator: 245.25.
> On a 528-person lab block, the nearest-exit rule takes 301 seconds and the Nikaas plan 167, 44.6 percent faster,
> and within 3.7 seconds of a proven lower bound: no plan can do better with those doors.
> Is that one lucky run? We fixed the plans and re-ran the museum 200 times with random start delays and
> head counts. Nikaas was faster in 193 of 200. In the other seven, fewer people turned up, and it lost about four seconds."

---

## 2:15 – 2:40 · Scale  *(Bhumika)*

> "It scales. On a five-floor tower that shares two stairwells, the nearest-exit rule sends all 450 people down one;
> Nikaas uses both: 375 seconds down to 206.
> On a representative stadium with 2,001 people, 348.5 seconds down to 203. And blocking the narrow metro-side gate
> makes even the nearest-exit rule faster, because that gate is where the jam forms. The Nikaas plan never uses it."

---

## 2:40 – 3:00 · Close  *(Chirag)*

> "Nikaas is live on AWS, its code is public on GitHub, and it starts from the map that is already on the wall.
> Photograph the exit map. Get everyone out faster."

---

## Do not say (we cannot back these)

- That our stadium is Chinnaswamy, or which gate "failed" on 4 June 2025. Our stadium is a representative building.
- That any corridor in our runs crosses the crush threshold: the stadium's peak is 2.69 p/m² with the nearest-exit rule,
  1.61 with the Nikaas plan, both below the 4 p/m² line. Densities come from a flow model, not a spatial crowd model.
- That other tools miss crowd density: commercial tools such as MassMotion and LEGION draw density maps. Our difference is
  starting from the photo on the wall and giving every room a plan.
- "Real-time crush prediction", "safe building", or a full escape time: our times are movement times (`docs/METHOD.md`).
- The 3D Sim page's times: it is an illustration; the validated numbers are the Twin and Evidence pages.

---

## Where each number comes from

| Said | Value | File |
|---|---|---|
| Museum, main entrance blocked: nearest / Nikaas | 318.0 s / 223.5 s | `runs/wow.csv` |
| SFPE worked example: published / ours | 245.2 s / 245.25 s | `runs/validation.csv` |
| Lab block: nearest / Nikaas / lower bound gap | 301.25 s / 166.75 s / 3.71 s (44.6%) | `runs/wow.csv` |
| Museum, 200 random runs: Nikaas faster / median loss in the others | 193 of 200 / 4.25 s | `runs/monte_carlo_summary.csv`, `docs/RESULTS.md` |
| Tower: nearest / Nikaas | 375.25 s / 206.0 s | `runs/multi_floor.csv` |
| Stadium (2,001): nearest / Nikaas; Gate South blocked, nearest | 348.5 s / 203.0 s; 203.0 s | `runs/stadium_results.csv` |
| Incidents (22, 23, 11) | Surat 2019, Elphinstone Road 2017, Chinnaswamy 2025 | Home page sources |
