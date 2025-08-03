# Benchmark Results Leaderboard

A Next.js application to display and analyze benchmark results from coding exercise evaluations.

## Features

- **Interactive Leaderboard**: Sortable table showing model performance metrics
- **Data Visualization**: Charts comparing success rates and cost vs performance
- **Model Comparison**: Detailed statistics for each model/provider/language combination
- **Responsive Design**: Works on desktop and mobile devices
- **Real-time Data**: Automatically loads latest benchmark results

## Getting Started

### Prerequisites

- Node.js 18+ 
- npm or yarn

### Installation

1. Install dependencies:
```bash
npm install
```

2. Run the development server:
```bash
npm run dev
```

3. Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

### Data Source

The application reads benchmark results from `../benchmarks/results/results.json`. Make sure to run benchmarks first to generate data.

Expected file structure:
```
benchmarks/
  results/
    results.json    # Main results file
    # Additional result files can be added here
```

## Project Structure

```
leaderboard/
├── app/
│   ├── globals.css       # Global styles
│   ├── layout.tsx        # Root layout
│   └── page.tsx          # Main page
├── components/
│   ├── LeaderboardTable.tsx    # Sortable results table
│   └── PerformanceChart.tsx     # Data visualization
├── types/
│   └── benchmark.ts      # TypeScript interfaces
├── utils/
│   └── dataProcessor.ts  # Data loading and aggregation
└── package.json
```

## Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run start` - Start production server
- `npm run lint` - Run ESLint

## Metrics Displayed

- **Success Rate**: Percentage of exercises completed successfully
- **Total Exercises**: Number of exercises attempted
- **Average Cost**: Mean cost per exercise in USD
- **Average Time**: Mean time per exercise in seconds
- **Average Turns**: Mean number of agent turns per exercise
- **Total Runs**: Number of benchmark runs for this model/language

## Charts

1. **Success Rate Comparison**: Bar chart showing top 10 models by success rate
2. **Cost vs Performance**: Scatter plot comparing cost efficiency vs success rate

## Customization

### Adding New Data Sources

Modify `utils/dataProcessor.ts` to load additional result files or change the aggregation logic.

### Styling

The application uses Tailwind CSS. Modify component styles directly in the JSX files or update `globals.css` for global changes.

### Adding New Charts

Use the Recharts library to create additional visualizations in `components/PerformanceChart.tsx`.

## Deployment

### Build for Production

```bash
npm run build
npm run start
```

### Deploy to Vercel

The easiest way to deploy is using the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme).

## Data Format

The application expects benchmark results in this format:

```json
{
  "config": {
    "language": "javascript",
    "model": "claude-sonnet-4",
    "provider": "openai",
    "maxExercises": 1,
    "limits": {
      "maxTurns": 20,
      "maxTime": 300,
      "maxCost": 1
    }
  },
  "exercises": [
    {
      "exerciseName": "accumulate",
      "status": "success",
      "turns": 1,
      "timeElapsed": 46.668,
      "cost": 0.090424,
      "startTime": "2025-08-02T07:26:04.029Z",
      "endTime": "2025-08-02T07:26:50.697Z"
    }
  ],
  "summary": {
    "totalExercises": 1,
    "successCount": 1,
    "totalTime": 46.668,
    "totalCost": 0.090424,
    "successRate": 1
  }
}
```