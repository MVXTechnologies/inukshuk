# Website screenshot sources

The website uses native app captures, with WebP encoding and resizing for the page.

The trail is Unter Bunderspitz, a ski tour in the Swiss Alps recorded on February 12, 2022. Source: [QGIS-CH workshop GPX](https://github.com/qgis-ch/mini-ws-gpxtracks/blob/cf9494bfe3a25e124ca0f4ba9fc89e21a56f35a2/2022-02-12_Unter_Bunderspitz.gpx), released under [CC0-1.0](https://github.com/qgis-ch/mini-ws-gpxtracks/blob/cf9494bfe3a25e124ca0f4ba9fc89e21a56f35a2/LICENSE).

The original 565 GPS points, elevations and timestamps were imported through the app's GPX importer. The name was shortened to Unter Bunderspitz and the activity set to ski; no route coordinates, recording times or statistics were invented. Original start/end timestamps: 2022-02-12T08:15:33.000Z–2022-02-12T12:22:16.999Z. The app displays 7.72 km and 4:06:43.

The simulator/emulator was used to choose the camera position and capture the UI. Device location in the main map is a simulator location, not a claim that the screenshot was taken during that outing. The recording was imported from the source above, not recorded with Inukshuk. Satellite imagery is the app's Esri basemap; it is not a photograph taken on the tour date.

The Library capture contains that imported recording in a Swiss Alps folder plus the PDF maps used in the local native test library. Offline-area and map-builder captures show the same Swiss mountain region. These screens show selection/configuration, not a fabricated completed download.

The Search capture shows actual NRCan CanTopo entries from the published app catalog. Its distance labels use the simulator’s last saved Canadian position.

| Asset                         | Native surface                                             |
| ----------------------------- | ---------------------------------------------------------- |
| 01-map-live-trail.webp        | Android emulator, 2D satellite map and imported track      |
| 02-trail-elevation-notes.webp | Android emulator, 2D trail detail and original GPX profile |
| 03-library-folders.webp       | iPhone simulator, Library                                  |
| 04-offline-download.webp      | iPhone simulator, offline-area selection                   |
| 05-map-maker.webp             | iPhone simulator, map-builder area selection               |
| 06-map-store.webp             | iPhone simulator, Search catalog                           |

3D is parked under [#284](https://github.com/MVXTechnologies/inukshuk/issues/284). Do not restore 3D screenshots or claims before that work is validated on native devices.
