export default function Spinner() {
  return (
    <div className="flex items-center justify-center py-20">
      <svg className="h-8 w-8 animate-spin" viewBox="0 0 32 32" fill="none">
        <circle cx="16" cy="16" r="14" stroke="url(#spin)" strokeWidth="3" strokeLinecap="round" />
        <defs>
          <linearGradient id="spin" x1="0" y1="0" x2="32" y2="32">
            <stop offset="0%" stopColor="#fdba74" />
            <stop offset="50%" stopColor="#f97316" />
            <stop offset="100%" stopColor="#c2410c" />
          </linearGradient>
        </defs>
      </svg>
    </div>
  );
}
