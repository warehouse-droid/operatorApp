CREATE TABLE IF NOT EXISTS dispatch_vendor_yards (
  id bigserial PRIMARY KEY,
  vendor text NOT NULL,
  yard text NOT NULL,
  aliases text NOT NULL DEFAULT '',
  day_label text NOT NULL DEFAULT 'Mon-Fri',
  window_start text NOT NULL DEFAULT '',
  window_end text NOT NULL DEFAULT '',
  instructions text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_vendor_yards_unique
  ON dispatch_vendor_yards (vendor, yard, day_label);

INSERT INTO dispatch_vendor_yards
  (vendor, yard, aliases, day_label, window_start, window_end, instructions, address)
VALUES
  ('UNILOCK', 'UNILOCK Ayr', 'ayr', 'Mon-Fri', '07:00', '17:00', '', '2977 Cedar Creek Rd RR#1, Ayr, ON N0B 1E0'),
  ('UNILOCK', 'UNILOCK Gormley', 'gormley,gromley', 'Mon-Fri', '07:00', '17:00', 'Appointment needed', '37 Gormley Rd E, Gormley, ON L0H 1G0'),
  ('UNILOCK', 'UNILOCK Pickering', 'pickering', 'Mon-Fri', '08:00', '16:00', '', '1890 Clements Rd, Pickering, ON L1W 3R8'),
  ('UNILOCK', 'UNILOCK Georgetown', 'georgetown', 'Mon-Fri', '07:00', '17:00', '', '287 Armstrong Ave, Georgetown, ON L7G 4X6'),
  ('BWS', 'BWS Uxbridge', 'uxbridge', 'Mon-Fri', '07:00', '16:00', 'Arrive by 15:30', '65 Anderson Blvd, Uxbridge, ON L9P 0C7'),
  ('BWS', 'BWS Uxbridge', 'uxbridge', 'Saturday', '07:00', '12:00', 'Arrive by 11:30', '65 Anderson Blvd, Uxbridge, ON L9P 0C7'),
  ('BWS', 'BWS Woodbridge', 'woodbridge', 'Mon-Fri', '', '', '', '8821 Weston Rd, Woodbridge, ON L4L 1A6'),
  ('PERMACON', 'PERMACON Milton', 'milton', 'Mon-Fri', '07:00', '17:00', 'Arrive by 16:30', '8375 5 Side Rd, Milton, ON L7J 0A1'),
  ('PERMACON', 'PERMACON Cambridge', 'cambridge', 'Mon-Fri', '07:00', '16:30', 'Arrive by 16:00', '1081 Rife Rd, Cambridge, ON N1R 5S3'),
  ('PERMACON', 'PERMACON Bolton', 'bolton', 'Mon-Fri', '07:00', '16:30', 'Arrive by 16:00', '3 Betomat Ct. Bolton, ON L7E 2V9'),
  ('TECHO', 'TECHO BLOC Vaughan', 'techo bloc vaughan,vaughan,north york,arrow', 'Mon-Fri', '07:00', '17:00', '', '720 Arrow Rd. North York, ON M9M 2M1'),
  ('TECHO', 'TECHO BLOC Ayr', 'techo bloc ayr,ayr,cedar creek', 'Mon-Fri', '07:00', '17:00', '', '2852 Cedar Creek Rd, Ayr, ON N0B 1E0'),
  ('OAKVILLE STONE', 'Oakville Stone', 'oakville stone,kamato', 'Mon-Fri', '07:30', '15:30', '', '960 Kamato Rd, Mississauga, ON L4W 2R6'),
  ('BEAVER VALLEY', 'Beaver Valley Stone', 'beaver,keele,maple', 'Mon-Fri', '07:00', '15:00', 'Arrive by 14:30', '12350 Keele St, Maple, ON L6A 2C4'),
  ('RYMAR', 'Rymar', 'rymar,oakville', 'Mon-Fri', '08:00', '16:00', '', '1273 North Service Rd E, Unit F10, Oakville, ON L6H 1A7'),
  ('RYMAR', 'Rymar', 'rymar,oakville', 'Saturday', '08:00', '15:00', '', '1273 North Service Rd E, Unit F10, Oakville, ON L6H 1A7'),
  ('CFC', 'CFC', 'cfc,satellite', 'Mon-Fri', '08:30', '16:00', '', '5115 Satellite Dr, Mississauga, ON L4W 5B6'),
  ('PORCEA', 'Porcea/STONEarch', 'porcea,stonearch,coleraine', 'Mon-Fri', '08:00', '16:30', '', '12393 Coleraine Dr, Bolton, ON L7E 3B4'),
  ('STONEARCH', 'Porcea/STONEarch', 'porcea,stonearch,coleraine', 'Mon-Fri', '08:00', '16:30', '', '12393 Coleraine Dr, Bolton, ON L7E 3B4'),
  ('BANAS', 'Banas Stone', 'banas,king street', 'Mon-Fri', '08:00', '15:45', '', '8144 King Street Bolton, ON L7E 0T8'),
  ('STONEROX', 'StoneRox', 'xrts,stonerox,bethesda,stouffville', 'Mon-Thu', '08:00', '15:00', '', '5291 Bethesda Side Rd, Stouffville, ON L4A 4A7'),
  ('STONEROX', 'StoneRox', 'xrts,stonerox,bethesda,stouffville', 'Friday', '08:00', '13:00', '', '5291 Bethesda Side Rd, Stouffville, ON L4A 4A7'),
  ('TRIPLE H', 'Triple H', 'triple h,putnam', 'Mon-Fri', '08:00', '17:00', '', '4366 Breen Rd., Putnam ON, N0L 2B0'),
  ('MA-CO', 'Ma-Co Clay Products', 'ma-co,maco,bright,oxford', 'Mon-Fri', '07:00', '16:30', '', '896474 Oxford County Rd. 3, Bright, ON N0J1B0')
ON CONFLICT (vendor, yard, day_label) DO NOTHING;
