// The same kernels as kernels.nib. Built with: clang --target=wasm32 -O3 -msimd128 -nostdlib

#define EXPORT(name) __attribute__((export_name(#name))) name
typedef unsigned int u32;

void *memset(void *p, int c, unsigned long n) { unsigned char *b = p; while (n--) *b++ = (unsigned char)c; return p; }
void *memcpy(void *d, const void *s, unsigned long n) { unsigned char *a = d; const unsigned char *b = s; while (n--) *a++ = *b++; return d; }

// ---- n-body

typedef struct { double x, y, z, vx, vy, vz, mass; } Body;
static Body bodies[5];
#define PI 3.141592653589793
#define SOLAR (4.0 * PI * PI)
#define YEAR 365.24

static double energy(void) {
  double e = 0.0;
  for (int i = 0; i < 5; i++) {
    Body *a = &bodies[i];
    e += 0.5 * a->mass * (a->vx * a->vx + a->vy * a->vy + a->vz * a->vz);
    for (int j = i + 1; j < 5; j++) {
      Body *b = &bodies[j];
      double dx = a->x - b->x, dy = a->y - b->y, dz = a->z - b->z;
      e -= a->mass * b->mass / __builtin_sqrt(dx * dx + dy * dy + dz * dz);
    }
  }
  return e;
}

double EXPORT(nbody)(int steps) {
  bodies[0] = (Body){0, 0, 0, 0, 0, 0, SOLAR};
  bodies[1] = (Body){4.84143144246472090, -1.16032004402742839, -0.103622044471123109, 0.00166007664274403694 * YEAR, 0.00769901118419740425 * YEAR, -0.0000690460016972063023 * YEAR, 0.000954791938424326609 * SOLAR};
  bodies[2] = (Body){8.34336671824457987, 4.12479856412430479, -0.403523417114321381, -0.00276742510726862411 * YEAR, 0.00499852801234917238 * YEAR, 0.0000230417297573763929 * YEAR, 0.000285885980666130812 * SOLAR};
  bodies[3] = (Body){12.8943695621391310, -15.1111514016986312, -0.223307578892655734, 0.00296460137564761618 * YEAR, 0.00237847173959480950 * YEAR, -0.0000296589568540237556 * YEAR, 0.0000436624404335156298 * SOLAR};
  bodies[4] = (Body){15.3796971148509165, -25.9193146099879641, 0.179258772950371181, 0.00268067772490389322 * YEAR, 0.00162824170038242295 * YEAR, -0.0000951592254519715870 * YEAR, 0.0000515138902046611451 * SOLAR};
  for (int s = 0; s < steps; s++) {
    for (int i = 0; i < 5; i++) {
      Body *a = &bodies[i];
      for (int j = i + 1; j < 5; j++) {
        Body *b = &bodies[j];
        double dx = a->x - b->x, dy = a->y - b->y, dz = a->z - b->z;
        double d2 = dx * dx + dy * dy + dz * dz;
        double mag = 0.01 / (d2 * __builtin_sqrt(d2));
        a->vx -= dx * b->mass * mag;
        a->vy -= dy * b->mass * mag;
        a->vz -= dz * b->mass * mag;
        b->vx += dx * a->mass * mag;
        b->vy += dy * a->mass * mag;
        b->vz += dz * a->mass * mag;
      }
    }
    for (int i = 0; i < 5; i++) {
      Body *b = &bodies[i];
      b->x += 0.01 * b->vx;
      b->y += 0.01 * b->vy;
      b->z += 0.01 * b->vz;
    }
  }
  return energy();
}

// ---- mandelbrot

int EXPORT(mandelbrot)(int size, int limit) {
  int total = 0;
  double scale = 2.0 / (double)size;
  for (int py = 0; py < size; py++) {
    double ci = (double)py * scale - 1.0;
    for (int px = 0; px < size; px++) {
      double cr = (double)px * scale - 1.5;
      double zr = 0.0, zi = 0.0;
      int i = 0;
      while (i < limit && zr * zr + zi * zi <= 4.0) {
        double t = zr * zr - zi * zi + cr;
        zi = 2.0 * zr * zi + ci;
        zr = t;
        i++;
      }
      total += i;
    }
  }
  return total;
}

// ---- particles on springs

#define COUNT 4096
static float X[COUNT], Y[COUNT], VX[COUNT], VY[COUNT];

static void reset(void) {
  for (int i = 0; i < COUNT; i++) {
    X[i] = (float)(i & 63) * 0.1f - 3.0f;
    Y[i] = (float)(i >> 6) * 0.1f - 3.0f;
    VX[i] = 0;
    VY[i] = 0;
  }
}
static float checksum(void) {
  float sum = 0;
  for (int i = 0; i < COUNT; i++) sum += X[i] + Y[i];
  return sum;
}

float EXPORT(particles)(int steps) {
  reset();
  for (int s = 0; s < steps; s++) {
    for (int i = 0; i < COUNT; i++) {
      VX[i] = (VX[i] - X[i] * 0.05f) * 0.999f;
      VY[i] = (VY[i] - Y[i] * 0.05f) * 0.999f;
      X[i] += VX[i] * 0.016f;
      Y[i] += VY[i] * 0.016f;
    }
  }
  return checksum();
}

// ---- 4x4 matrix products

static float ma[16], mb[16];

static void mat4_mul(float *out, const float *a, const float *b) {
  float t[16];
  for (int j = 0; j < 4; j++)
    for (int r = 0; r < 4; r++)
      t[j * 4 + r] = a[r] * b[j * 4] + a[4 + r] * b[j * 4 + 1] + a[8 + r] * b[j * 4 + 2] + a[12 + r] * b[j * 4 + 3];
  for (int i = 0; i < 16; i++) out[i] = t[i];
}

float EXPORT(mat4)(int n) {
  static const float identity[16] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
  static const float turn[16] = {0.8f, 0.6f, 0, 0, -0.6f, 0.8f, 0, 0, 0, 0, 1, 0, 0.001f, 0.002f, 0.003f, 1};
  for (int i = 0; i < 16; i++) { ma[i] = identity[i]; mb[i] = turn[i]; }
  for (int i = 0; i < n; i++) mat4_mul(ma, ma, mb);
  float s[4];
  for (int r = 0; r < 4; r++) s[r] = ma[r] + ma[4 + r] + ma[8 + r] + ma[12 + r];
  return s[0] + s[1] + s[2] + s[3];
}

// ---- sieve

#define LIMIT 2000000
static unsigned char flags[LIMIT];

int EXPORT(sieve)(int n) {
  memset(flags, 1, n);
  int count = 0;
  for (int i = 2; i < n; i++) {
    if (flags[i] != 0) {
      count++;
      for (int j = i + i; j < n; j += i) flags[j] = 0;
    }
  }
  return count;
}

// ---- integer mixing

u32 EXPORT(hash)(u32 n) {
  u32 h = 2166136261u;
  for (u32 i = 0; i < n; i++) {
    h = (h ^ i) * 16777619u;
    h = h ^ h >> 13;
    h = (h << 7 | h >> 25) + i;
  }
  return h;
}

// ---- calls

int EXPORT(fib)(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
