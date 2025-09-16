# ARGO Floats Visualization

A Node.js + Express web application that visualizes ARGO float data on an interactive Mapbox + Deck.gl map.

## Features

- **Interactive Map**: Satellite view with ARGO float positions
- **Data Filtering**: Filter by BGC (Biogeochemical) or Core floats
- **Float Details**: Click any float to view its details and trajectory
- **Depth Profiles**: Modal popup with 5 depth-vs-variable charts:
  - Temperature (°C)
  - Salinity (PSU) 
  - Oxygen (μmol/kg)
  - Nitrate (μmol/kg)
  - pH
- **Search**: Search floats by ID
- **Dark Theme**: Modern dark UI throughout

## Data Structure

The app reads CSV files from:
- `data/bgc/` - Biogeochemical floats (green markers)
- `data/core/` - Core floats (blue markers)

Each CSV should contain columns: `LATITUDE`, `LONGITUDE`, `PRES`, `JULD`, `PLATFORM_NUMBER`, `TEMP`, `PSAL`, `DOXY`, `NITRATE`, `PH_IN_SITU_TOTAL`.

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Set Mapbox token:**
   - Get a free token from [Mapbox](https://www.mapbox.com/)
   - Set environment variable: `MAPBOX_TOKEN=your_token_here`
   - Or replace the token in `views/map.ejs`

3. **Add your CSV data:**
   - Place ARGO CSV files in `data/bgc/` and `data/core/`
   - Files should be named `argo-profiles-*.csv`

4. **Run the server:**
   ```bash
   node app.js
   ```

5. **Open in browser:**
   - Navigate to `http://localhost:3000`

## Usage

- **Left Panel**: Filter floats by type, search by ID, click to select
- **Map**: View float positions, click markers to select
- **Right Panel**: View selected float details, click "Show Depth Profiles" for charts
- **Charts Modal**: View depth profiles for temperature, salinity, oxygen, nitrate, and pH

## Technology Stack

- **Backend**: Node.js, Express, EJS
- **Frontend**: Mapbox GL JS, Deck.gl, Chart.js
- **Data Processing**: Stream-based CSV parsing for memory efficiency

## License

MIT
