# Store badges

Official artwork, downloaded unmodified from the vendors. Both companies
require their own files: a redrawn or restyled badge breaches their brand
guidelines, so replace these only by re-downloading from the same sources.

| File                 | Source                                                                             |
| -------------------- | ---------------------------------------------------------------------------------- |
| `app-store-en.svg`   | <https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg> |
| `app-store-fr.svg`   | Apple Marketing Tools, `download-on-the-app-store/black/fr-ca`                     |
| `google-play-en.png` | <https://play.google.com/intl/en_us/badges/> (generic, English)                    |
| `google-play-fr.png` | <https://play.google.com/intl/fr_fr/badges/> (generic, French)                     |

## The Google Play badges are staged, not used

Google's guidelines require the badge to link to a Play **listing**, and
Inukshuk has no public one — `play.google.com/store/apps/details?id=com.inukshuk.app`
returns 404. Until the track is public the site shows a plainly-labelled beta
invite instead. When the listing goes live, swap the Android `<a class="store">`
in `docs/index.html` and `docs/fr/index.html` for these badges.

Apple's badge may be scaled but not altered or recoloured, which is why it sets
the button height in the hero and the Android button is built to match it.
