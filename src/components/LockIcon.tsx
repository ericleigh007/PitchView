type LockIconProps = {
  locked: boolean;
};

export function LockIcon({ locked }: LockIconProps) {
  return locked ? (
    <svg aria-hidden="true" className="lock-icon" viewBox="0 0 24 24">
      <path d="M7 10V8a5 5 0 0 1 10 0v2h1.5A1.5 1.5 0 0 1 20 11.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19.5v-8A1.5 1.5 0 0 1 5.5 10H7Zm2 0h6V8a3 3 0 1 0-6 0v2Z" />
    </svg>
  ) : (
    <svg aria-hidden="true" className="lock-icon" viewBox="0 0 24 24">
      <path d="M17 10h1.5A1.5 1.5 0 0 1 20 11.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19.5v-8A1.5 1.5 0 0 1 5.5 10H15V8a3 3 0 0 0-5.78-1.22l-1.84-.78A5 5 0 0 1 17 8v2Z" />
    </svg>
  );
}